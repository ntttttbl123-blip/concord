# Google sign-in

Concord uses Google to verify an email address and sign a person in. It does not use Google to
access a person's Drive or other Google data.

## Configure Google

1. Set `CONCORD_PUBLIC_URL` to the public origin people use to open Concord, such as
   `https://concord.example.com`. The origin must use HTTPS outside local development.
2. In the [Google Cloud Console](https://console.cloud.google.com/), open **Google Auth Platform →
   Clients** and create an OAuth client with application type **Web application**. Google's
   [web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
   describes the client setup.
3. Add this exact **Authorized redirect URI** to the client:

   ```text
   <CONCORD_PUBLIC_URL>/api/auth/google/callback
   ```

   For example, if `CONCORD_PUBLIC_URL` is `https://concord.example.com`, the URI is
   `https://concord.example.com/api/auth/google/callback`. Google requires the redirect URI to
   match exactly, including the scheme, host, path, letter case and trailing slash.
4. Set both values in Concord's server environment, then restart the service:

   ```dotenv
   CONCORD_GOOGLE_CLIENT_ID=your-client-id
   CONCORD_GOOGLE_CLIENT_SECRET=your-client-secret
   ```

   Keep the client secret in the deployment's secret store; do not commit it to the repository.
   Concord shows Google sign-in buttons only when both values are set. Set neither to disable
   Google sign-in; setting only one prevents the server from starting.

`CONCORD_PUBLIC_URL` determines the redirect URI and cookie security. The Google client and
Concord must use the same public origin. If Google reports `redirect_uri_mismatch`, compare the
URI in the client with the example above, including `https` and the full callback path.

## New workspaces and sign-up codes

With `CONCORD_SIGNUP=open` (the default), a person can create a workspace with a verified Google
account. On first use, Concord creates the account and a new workspace for that person.

With `CONCORD_SIGNUP=code`, the server operator must provide a sign-up code. Create one with
`pnpm concord signup-code`; enter it on the sign-up page before choosing **Sign up with Google**.
The code is one-time and expires after 14 days by default. A valid invitation is a separate path:
accepting an invitation with Google joins the invited workspace and does not require a sign-up code.

## Invitations

An owner creates an invitation for a specific email address and shares its link with that person.
The link expires after seven days. On the invitation page, use the account for the invited address:

- If that address has no Concord account yet, choose **Join with Google** and use a Google account
  with the same email address. Concord creates the account and joins it to the invited workspace.
- If the address already has an account, sign in as that account and choose **Join workspace**.
  A password account must first be signed in with its password; an invitation does not add a Google
  credential to an existing account.
- If you are already signed in with a different email address, sign out and use the account named
  in the invitation.

## Existing password accounts

Concord does not automatically merge a Google identity with an existing password account, even
when the email addresses match. First sign in with the account's password. In **Settings**, choose
**Connect Google**, then sign in to the Google account with the same verified email address. After
it is connected, that account can use either sign-in method.

## Sign-in errors

These codes are returned to the sign-in page (or to **Settings** when connecting Google):

| Code | What it means | What to do |
|---|---|---|
| `google_exists` | A Concord account already uses this email and Google is not connected to it. | Sign in with the account's password, then connect Google in **Settings**. |
| `google_unverified` | Google has not verified the email address. | Verify the address with Google, then try again. |
| `google_cancelled` | The Google sign-in was cancelled. | Start sign-in again if you still want to continue. |
| `google_failed` | The OAuth flow did not complete, including a missing or invalid state, or another unexpected error. | Try again. If it repeats, check the callback URI and the server logs. |
| `google_mismatch` | The Google account does not use the email address on the Concord account being linked. | Connect the Google account with the same verified email address. |
| `signup_code` | The server requires a sign-up code and the submitted code was not valid. | Ask the server operator for a current code. |

An unrecognized error code is shown as `google_failed`.

## Implementation references

- `services/api/src/config.ts` and `.env.example` define the public URL and Google environment
  variables.
- `services/api/src/auth-api.ts` builds the callback URI and handles the OAuth callback.
- `services/api/src/auth.ts` handles sign-up codes, invitations, existing accounts and Google
  account linking.
- `apps/web/src/Auth.tsx` and `apps/web/src/Settings.tsx` show the sign-in buttons and messages.
