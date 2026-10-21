import { useState } from "react";
import { api, type Me, type Role, type Team } from "./api";
import { Password, googleError } from "./Auth";
import { useMe, useSession } from "./session";
import { Badge, Button, ErrorNote, Field, LinkButton, Section, Skeleton, TableWrap, inputClass, useAction, useLoad, when } from "./ui";

function Saved({ text }: { text: string | undefined }) {
  return text ? (
    <p role="status" className="text-[13px] text-ok">
      {text}
    </p>
  ) : null;
}

function Account({ notice }: { notice?: string | undefined }) {
  const me = useMe();
  const { config, adopt } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saved, setSaved] = useState<string>();
  const save = useAction();
  return (
    <Section title="Your account">
      <dl className="grid max-w-xl grid-cols-[120px_1fr] gap-y-2 text-[13px]">
        <dt className="text-muted">Name</dt>
        <dd>{me.user.name}</dd>
        <dt className="text-muted">Email</dt>
        <dd>{me.user.email}</dd>
        <dt className="text-muted">Sign-in</dt>
        <dd className="flex flex-wrap gap-1.5">
          {me.user.hasPassword && <Badge tone="neutral">Password</Badge>}
          {me.user.hasGoogle && <Badge tone="neutral">Google</Badge>}
        </dd>
      </dl>
      <Saved text={notice} />
      <form
        className="flex max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(undefined);
          void save
            .run(async () => {
              await api("/auth/password", { body: { ...(me.user.hasPassword ? { current } : {}), next } });
              await adopt();
            })
            .then((ok) => {
              if (!ok) return;
              setCurrent("");
              setNext("");
              setSaved("Password saved. Your other sessions were signed out.");
            });
        }}
      >
        {me.user.hasPassword && <Password label="Current password" value={current} onChange={setCurrent} />}
        <Password label={me.user.hasPassword ? "New password" : "Set a password"} value={next} onChange={setNext} fresh />
        {save.error && <ErrorNote message={save.error} />}
        <Saved text={saved} />
        <div>
          <Button busy={save.busy} type="submit">
            {me.user.hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </form>
      {config.google && !me.user.hasGoogle && (
        <div className="flex max-w-xl flex-col items-start gap-2">
          <p className="text-[13px] text-muted">
            Connect the Google account for {me.user.email} to sign in without the password.
          </p>
          <LinkButton href="/api/auth/google/start?link=1">Connect Google</LinkButton>
        </div>
      )}
    </Section>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<{ email: string; url: string }>();
  const [copied, setCopied] = useState(false);
  const send = useAction();
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setCopied(false);
          void send.run(async () => {
            const out = await api<{ email: string; link: string }>("/org/invites", { body: { email, role } });
            setLink({ email: out.email, url: out.link });
            setEmail("");
            onDone();
          });
        }}
      >
        <div className="min-w-[240px] flex-1">
          <Field label="Invite by email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} required />
          </Field>
        </div>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
        <Button variant="primary" busy={send.busy} type="submit">
          Create invitation
        </Button>
      </form>
      {send.error && <ErrorNote message={send.error} />}
      {link && (
        <div className="flex flex-col gap-2 rounded border border-line bg-surface p-3">
          <p className="text-[13px]">
            Send this link to {link.email}. Concord does not send email. The link works once, for seven days, and is not
            shown again.
          </p>
          <div className="flex flex-wrap gap-2">
            <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" className={`${inputClass} num min-w-0 flex-1`} />
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(link.url)
                  .then(() => setCopied(true))
                  .catch(() => undefined);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TeamSection() {
  const me = useMe();
  const { adopt } = useSession();
  const team = useLoad(() => api<Team>("/org/members"), [me.org.id]);
  const act = useAction();
  const owner = me.role === "owner";
  const change = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      team.reload();
    });
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  return (
    <Section title="Team">
      <p className="max-w-[65ch] text-[13px] text-muted">
        Members watch assets, upload books and sign off breaks. Owners also invite and remove people, stop watching
        assets and can delete the workspace.
      </p>
      {team.loading && !team.data && <Skeleton rows={3} />}
      {team.error && <ErrorNote message={team.error} />}
      {act.error && <ErrorNote message={act.error} />}
      {team.data && (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {team.data.members.map((m) => {
                const self = m.id === me.user.id;
                return (
                  <tr key={m.id}>
                    <td className="font-medium">
                      {m.name}
                      {self && <span className="ml-2 text-xs font-normal text-muted">you</span>}
                    </td>
                    <td className="text-[13px]">{m.email}</td>
                    <td>
                      {owner && !self ? (
                        <select
                          aria-label={`Role of ${m.name}`}
                          value={m.role}
                          disabled={act.busy}
                          onChange={(e) => void change(() => api(`/org/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}
                          className={`${inputClass} w-auto`}
                        >
                          <option value="member">Member</option>
                          <option value="owner">Owner</option>
                        </select>
                      ) : (
                        <span className="text-[13px] capitalize">{m.role}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[13px] text-muted">{m.joinedAt.slice(0, 10)}</td>
                    <td className="r">
                      {owner && !self && (
                        confirmRemoveId === m.id ? (
                          <div className="flex min-w-0 flex-col items-start gap-3 py-2">
                            <div className="max-w-xs text-left text-[13px] leading-relaxed">
                              <p className="font-medium">Remove {m.name}?</p>
                              <p className="mt-1 text-muted">
                                Their account will be deleted if they belong to no other workspace.
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                busy={act.busy}
                                onClick={() => {
                                  void change(async () => {
                                    await api(`/org/members/${m.id}`, { method: "DELETE" });
                                    setConfirmRemoveId(null);
                                  });
                                }}
                              >
                                Confirm
                              </Button>
                              <Button
                                disabled={act.busy}
                                onClick={() => setConfirmRemoveId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            busy={act.busy}
                            onClick={() => setConfirmRemoveId(m.id)}
                          >
                            Remove
                          </Button>
                        )
                      )}
                      {self && me.orgs.length > 1 && (
                        <Button
                          busy={act.busy}
                          onClick={() =>
                            void act.run(async () => {
                              await api(`/org/members/${m.id}`, { method: "DELETE" });
                              await adopt();
                            })
                          }
                        >
                          Leave
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {owner && team.data && team.data.invites.length > 0 && (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>Invitation pending</th>
                <th>Role</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {team.data.invites.map((i) => (
                <tr key={i.id}>
                  <td className="text-[13px]">{i.email}</td>
                  <td className="text-[13px] capitalize">{i.role}</td>
                  <td className="whitespace-nowrap text-[13px] text-muted">{when(i.expiresAt)}</td>
                  <td className="r">
                    <Button busy={act.busy} onClick={() => void change(() => api(`/org/invites/${i.id}`, { method: "DELETE" }))}>
                      Withdraw
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {owner && <InviteForm onDone={team.reload} />}
    </Section>
  );
}

function Workspace() {
  const me = useMe();
  const { adopt } = useSession();
  const [name, setName] = useState(me.org.name);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState<string>();
  const rename = useAction();
  const remove = useAction();
  const swap = useAction();
  const owner = me.role === "owner";
  return (
    <Section title="Workspace">
      {me.orgs.length > 1 && (
        <div className="max-w-sm">
          <Field label="Showing" hint="You belong to more than one workspace.">
            <select
              value={me.org.id}
              disabled={swap.busy}
              onChange={(e) =>
                void swap.run(async () => {
                  await adopt(await api<Me>("/auth/switch-org", { body: { orgId: e.target.value } }));
                  location.hash = "#/";
                })
              }
              className={inputClass}
            >
              {me.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          {swap.error && <ErrorNote message={swap.error} />}
        </div>
      )}
      {owner ? (
        <form
          className="flex max-w-sm flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(undefined);
            void rename
              .run(async () => adopt(await api<Me>("/org", { method: "PATCH", body: { name } })))
              .then((ok) => ok && setSaved("Workspace renamed."));
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={80} required />
          </Field>
          {rename.error && <ErrorNote message={rename.error} />}
          <Saved text={saved} />
          <div>
            <Button busy={rename.busy} type="submit" disabled={name.trim() === me.org.name}>
              Rename
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-[13px]">
          {me.org.name} <span className="text-muted">· you are a member</span>
        </p>
      )}
      {owner && (
        <div className="flex max-w-xl flex-col items-start gap-3 border-t border-line pt-4">
          <p className="text-[13px] text-muted">
            Deleting the workspace removes every watched asset, register, journal, instruction, reconciliation and
            sign-off in it, and the accounts of people who belong to no other workspace. It cannot be undone.
          </p>
          {!deleting ? (
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete workspace
            </Button>
          ) : (
            <form
              className="flex w-full max-w-sm flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void remove.run(async () => {
                  await api("/org", { method: "DELETE", body: { confirm } });
                  await adopt(null);
                  location.hash = "#/";
                });
              }}
            >
              <Field label={`Type "${me.org.name}" to confirm`}>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} autoFocus required />
              </Field>
              {remove.error && <ErrorNote message={remove.error} />}
              <div className="flex gap-2">
                <Button variant="danger" busy={remove.busy} type="submit" disabled={confirm !== me.org.name}>
                  Delete everything
                </Button>
                <Button
                  onClick={() => {
                    setDeleting(false);
                    setConfirm("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Section>
  );
}

export function Settings({ query }: { query: URLSearchParams }) {
  const error = googleError(query.get("error") ?? undefined);
  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>
      {error && <ErrorNote message={error} />}
      <Account notice={query.get("linked") === "google" ? "Google is connected. You can sign in with it from now on." : undefined} />
      <TeamSection />
      <Workspace />
    </div>
  );
}
