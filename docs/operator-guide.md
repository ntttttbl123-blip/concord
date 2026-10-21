# Operator guide

For whoever runs a Concord server. It covers the three things only an operator can do: let a new
customer create a workspace, get someone back into an account, and remove a workspace. Concord
sends no email, so each of these ends with you passing something on to a person.

The commands are run on the server, against the same data directory as the running service. They
are listed in full in the repository's command-line source,
[`services/api/src/cli.ts`](../services/api/src/cli.ts). Run them as `pnpm --silent concord ...`
from inside the checkout (the plain `pnpm concord` form prints two banner lines first). The
Docker image has no `pnpm` command line: it contains the compiled program, so the equivalent is
`node services/api/dist/cli.js <command>` (I did not run it there). The examples below use the
`pnpm` form.

## Sign-up codes

### Turning the requirement on

By default anyone who can reach the server can create a workspace (`CONCORD_SIGNUP=open`). To
make workspaces by invitation of the operator, set:

```
CONCORD_SIGNUP=code
```

This is read when the server starts, so restart it after changing it
(`services/api/src/config.ts`). Any value other than `open` or `code` stops the server with
`CONCORD_SIGNUP must be open or code`.

With `code`, the sign-up form shows a *Sign-up code* field and says each code opens one
workspace. A code is not needed to join an existing workspace by invitation: that goes through
the invitation link an owner creates.

### Issuing a code

```sh
pnpm --silent concord signup-code --note "Example Customer Ltd"
```

It prints the code on its own line, sixteen characters from `A-Z`, `a-z`, `0-9`, `-` and `_`
(`newToken`, `services/api/src/security.ts`). Case matters. `--note` is optional text stored
with the code.

- **Lifetime:** 14 days from the moment it is made (`Auth.createSignupCode`,
  `services/api/src/auth.ts`).
- **One use:** a code is marked used by the sign-up that spends it. The mark and the account and
  workspace it creates are written in one transaction, so a sign-up that fails (a taken email,
  say) does not use the code up.
- **Stored hashed.** Only a hash of the code is kept. The code cannot be shown again, and **there
  is no command that lists codes, issued or outstanding**. The note is stored with the hash but
  nothing reads it back, so keep your own record of who was given which code.
- A used or expired code is refused with `New workspaces need a sign-up code from the operator.`

The code works for password sign-up and for Google sign-up of a new workspace. Both spend it.

### Delivering it

The code lets whoever holds it create a workspace on your server until it is used or expires.
Treat it like a temporary password: send it to the named person over a channel you trust, send
the server address separately from it, and do not post it in a shared channel or a ticket that
others can read. If you suspect it has been seen by someone else, you cannot revoke it (no
command does); either let the real owner use it straight away, or wait out the 14 days.

## Reset links

A forgotten password is reset by a link you create. There is no "forgot password" email.

```sh
pnpm --silent concord reset-link person@example.com
```

It prints:

```
<CONCORD_PUBLIC_URL>/#/reset/<token>
Valid for one day, once. Send it to the account's owner over a channel you trust.
```

- **Set `CONCORD_PUBLIC_URL` first** (for example `https://concord.example.com`). Without it the
  link points at the server's local address, which is useless to the person you send it to.
- **Lifetime:** one day (`RESET_LIFE_MS`, `services/api/src/auth.ts`). **One use.**
- An unknown email fails with `no account for person@example.com` and creates nothing.
- The token is stored hashed and is 43 characters of base64url (32 random bytes).
- Making another link does not cancel an earlier one. Each stays valid until it is used or
  expires, so if you sent a link to the wrong place, you cannot withdraw it; the one day limit is
  the only bound.

What happens when it is used: the person chooses a new password (at least ten characters, and not
their email address), the link is marked used, **every session of that account is signed out**
everywhere, and they are signed in again on the browser that used the link. The reset sets a
password even on an account that so far only signed in with Google, which then has both.

The reset link, not a password, is what you send. Never choose a password for someone else:
there is no command for it.

### Delivering links safely

- Send it to the account's owner, not to a shared mailbox. Confirm who they are by a means other
  than the message the link arrives in, since anyone who holds the link can take over the account
  until it is used.
- Use a private channel you trust, and send it once. Do not paste it into a ticket, a chat room
  or a log.
- Ask them to use it straight away. It expires in a day regardless.
- Check `https` in the link before you send it.
- After they have used it, they are the only one with the new password. Ask them to confirm they
  can sign in.

## Workspaces

### Listing them

```sh
pnpm --silent concord orgs
```

A table of every workspace: `id` (sixteen hex characters), `name`, `members` (a count) and
`created`. Names are not unique; where two workspaces share one, name it by id.

### Deleting one

```sh
pnpm --silent concord org-delete "Example Customer Ltd"
pnpm --silent concord org-delete 0123456789abcdef
```

The argument is an id or an exact name; a name that matches two workspaces is refused. It asks
for no confirmation and prints `deleted NAME (ID)` when done. **It cannot be undone.** Take a
backup first:

```sh
pnpm --silent concord backup /srv/backups/before-delete-$(date -u +%F)
```

What it removes (`Auth.deleteOrg`, `Tenants.drop`):

| Removed | Detail |
|---|---|
| The workspace record | Its row in `control.db`. |
| Its memberships, sessions and invitations | They cascade from the workspace, so everyone is signed out of it at once and unaccepted invitation links stop working. |
| Accounts left with no workspace | An account that belonged only to this workspace is deleted, with its credentials and reset tokens. Its email can be used to sign up again. An account that also belongs to another workspace is kept. |
| The workspace database | `orgs/<id>.db`, with its `-wal` and `-shm` files: every watched asset, indexed event, uploaded register, journal, instruction, reconciliation, corporate action and sign-off. |

What it does not touch:

- Anything on Stellar. Concord only reads the chain.
- Backups you made earlier.
- Unused sign-up codes (they belong to no workspace).

A running server keeps a database file open once it has used it. `org-delete` removes the file
from the command-line process; the server's own handle stays until it restarts. I read this in
`Tenants` and did not test it, so restart the server after deleting a workspace, and expect the
deletion of a file the server holds open to behave differently on Windows than on Linux.

## Checklist: onboarding a customer

Once, per server:

- [ ] `CONCORD_SIGNUP=code`, and the server restarted.
- [ ] `CONCORD_PUBLIC_URL` is the `https` address people open. It decides cookie security and the
      Google redirect address, and is what reset links are built from.
- [ ] The data directory is on a local disk with persistent storage. On Render's free plan it is
      erased whenever the service restarts; do not onboard a customer there. See
      [`README.md`](../README.md#deploying).
- [ ] Mainnet RPC is a provider you pay for if the customer will watch real assets
      (`CONCORD_MAINNET_RPC_URLS`).
- [ ] A backup runs on a schedule (`concord backup`), and you have restored one at least once.

For each customer:

1. [ ] Decide who the first person is. They become the workspace **owner**.
2. [ ] `pnpm --silent concord signup-code --note "<customer>"`. Write down who it is for and the
       date; no command will tell you later.
3. [ ] Send the code, and separately the server address, over a channel you trust. Tell them it
       lasts 14 days and works once.
4. [ ] They sign up with their name, email, a workspace name and a password of ten or more
       characters, and the code (or continue with Google, if you have enabled it).
5. [ ] Check it worked: `pnpm --silent concord orgs` shows the new workspace with `members` of 1.
       If the code was refused, issue a new one; a failed sign-up does not use it up.
6. [ ] Tell them how it behaves:
   - It sends no email. Their team is invited with links they create under *Settings*, in the *Team* section, and pass on
     themselves; an invitation link lasts seven days.
   - Passwords are reset through you, with `reset-link`.
   - Email addresses are not verified at sign-up.
7. [ ] Agree who keeps the second owner role, so a workspace is not left depending on one person
       (a workspace needs at least one owner, and the last owner cannot be demoted or removed).
8. [ ] The customer watches their asset. A workspace can watch up to `CONCORD_MAX_ASSETS`
       (default 10). That limit is checked on the dashboard; `concord watch` on the command line
       does not apply it.
9. [ ] Confirm the first backup includes the new workspace (`backed up control.db and N
       workspaces`, where N has gone up by one).
10. [ ] Note your own record of the customer, the workspace id from `concord orgs`, the date and
        the code you issued, for the day you need to find or remove them.
