import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { backup } from "node:sqlite";
import { parseArgs } from "node:util";
import type { ActionInput, Actor, Concord, WatchInput } from "./concord.js";
import { isNetworkName, loadConfig } from "./config.js";
import { openRuntime, startServer } from "./main.js";
import { USAGE } from "./cli-usage.js";

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return console.log("(none)");
  console.table(rows);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      org: { type: "string" },
      network: { type: "string" },
      name: { type: "string" },
      "no-baseline": { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      ignore: { type: "string" },
      decimals: { type: "string" },
      "as-of": { type: "string" },
      register: { type: "string" },
      record: { type: "string" },
      rate: { type: "string" },
      ratio: { type: "string" },
      "pay-asset": { type: "string" },
      payer: { type: "string" },
      until: { type: "string" },
      label: { type: "string" },
      exclude: { type: "string" },
      csv: { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, a, b] = positionals;
  if (!command || values.help) return console.log(USAGE);
  if (command === "serve") return startServer();

  const config = loadConfig();
  const runtime = openRuntime(config);
  const { auth, tenants } = runtime;
  const actor: Actor = { id: "cli", label: `cli:${userInfo().username}` };
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
    return value;
  };
  const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const orgRef = values.org ?? process.env.CONCORD_ORG;
  const workspace = (): Concord => tenants.forOrg(auth.findOrg(need(orgRef, "--org (see `concord orgs`)")).id);
  const printRun = (run: Awaited<ReturnType<Concord["reconcile"]>>) => {
    if (values.json) return out(run);
    console.log(`reconciliation ${run.id} · as of ${run.asOf} · ${run.status.toUpperCase()}`);
    for (const w of run.warnings) console.log(`  warning: ${w}`);
    console.table(run.summary);
    table(
      run.breaks.map((x) => ({
        type: x.type,
        subject: x.address ?? x.ref ?? "",
        chain: x.chainUnits ?? "",
        register: x.registerUnits ?? "",
        diff: x.difference ?? "",
        status: x.status,
      })),
    );
  };

  switch (command) {
    // ── operator ────────────────────────────────────────────────────────────
    case "orgs":
      table(auth.listOrgs().map((o) => ({ id: o.id, name: o.name, members: o.members, created: o.created_at })));
      break;
    case "signup-code":
      console.log(auth.createSignupCode(values.note));
      break;
    case "reset-link":
      console.log(`${config.publicUrl}/#/reset/${auth.createResetToken(need(a, "email"))}`);
      console.log("Valid for one day, once. Send it to the account's owner over a channel you trust.");
      break;
    case "org-delete": {
      const org = auth.findOrg(need(a, "workspace"));
      auth.deleteOrg(org.id);
      tenants.drop(org.id);
      console.log(`deleted ${org.name} (${org.id})`);
      break;
    }
    case "backup": {
      const dir = resolve(need(a, "directory"));
      mkdirSync(join(dir, "orgs"), { recursive: true });
      await backup(runtime.control.raw, join(dir, "control.db"));
      for (const id of auth.orgIds()) await backup(tenants.forOrg(id).db.raw, join(dir, "orgs", `${id}.db`));
      console.log(`backed up control.db and ${auth.orgIds().length} workspaces to ${dir}`);
      break;
    }

    // ── workspace ───────────────────────────────────────────────────────────
    case "watch": {
      const network = values.network ?? config.defaultNetwork;
      if (!isNetworkName(network)) throw new Error("--network must be mainnet or testnet");
      const input: WatchInput = { network, asset: need(a, "asset"), ignore: list(values.ignore) };
      if (values.name) input.name = values.name;
      if (values["no-baseline"]) input.baseline = false;
      if (values.from) input.fromLedger = Number(values.from);
      if (values.decimals) input.decimals = Number(values.decimals);
      const concord = workspace();
      const asset = await concord.watchAsset(input, { actor });
      const { added } = await concord.sync(asset.id);
      console.log(`watching ${asset.code} (${asset.id}) on ${asset.network} from ledger ${asset.startLedger}; ${added} events indexed`);
      break;
    }
    case "unwatch":
      await workspace().unwatchAsset(need(a, "asset"));
      console.log("stopped watching; the asset and its books are deleted");
      break;
    case "rebuild": {
      const asset = await workspace().rebuild(need(a, "asset"));
      console.log(`rebuilt ${asset.code} from ledger ${asset.startLedger}`);
      break;
    }
    case "assets":
      table(
        workspace()
          .overview()
          .assets.map((x) => ({
            code: x.code,
            network: x.network,
            supply: x.supply,
            holders: x.holderCount,
            events: x.eventCount,
            syncedAt: x.syncedAt ?? "",
            lastRun: x.lastRun?.status ?? "",
            openBreaks: x.openBreaks.reconciliation + x.openBreaks.controls + x.openBreaks.actions,
            problem: x.syncError ?? "",
          })),
      );
      break;
    case "sync":
      if (a) out(await workspace().sync(a));
      else if (orgRef) out(await workspace().syncAll());
      else out(await tenants.syncAll());
      break;
    case "holdings": {
      const h = workspace().holdings(need(a, "asset"), values["as-of"]);
      if (values.json) return out(h);
      console.log(`supply ${h.supply} · ${h.holderCount} holders · ledger ${h.ledger}`);
      table(h.holders);
      break;
    }
    case "register": {
      const concord = workspace();
      const asset = need(a, "asset");
      const file = need(b, "file");
      const imported = concord.importRegister(
        asset,
        { csv: readFileSync(file, "utf8"), asOf: need(values["as-of"], "--as-of"), source: file },
        actor,
      );
      console.log(`register ${imported.registerId}: ${imported.positions} positions, ${imported.issues.length} rejected rows`);
      for (const issue of imported.issues) console.log(`  line ${issue.line}: ${issue.message}`);
      printRun(await concord.reconcile(asset, imported.registerId, actor));
      break;
    }
    case "journal":
      out(workspace().importJournal(need(a, "asset"), readFileSync(need(b, "file"), "utf8")));
      break;
    case "instructions":
      out(workspace().importInstructions(need(a, "asset"), readFileSync(need(b, "file"), "utf8")));
      break;
    case "reconcile":
      printRun(await workspace().reconcile(need(a, "asset"), values.register ? Number(values.register) : undefined, actor));
      break;
    case "action": {
      const type = need(b, "action type") as ActionInput["type"];
      const input: ActionInput = { type, recordTime: need(values.record, "--record"), exclude: list(values.exclude) };
      if (values.label) input.label = values.label;
      if (values.until) input.windowTo = values.until;
      if (type === "dividend") {
        input.ratePerUnit = need(values.rate, "--rate");
        if (values["pay-asset"]) input.payAsset = values["pay-asset"];
        if (values.payer) input.payer = values.payer;
      } else {
        const [num, den] = need(values.ratio, "--ratio").split(":");
        input.num = need(num, "ratio numerator");
        input.den = need(den, "ratio denominator");
      }
      const action = await workspace().createAction(need(a, "asset"), input, actor);
      if (values.json) return out(action);
      console.log(`${action.label} · record ${action.recordTime} · ${action.state.toUpperCase()}`);
      if (action.result) {
        for (const w of action.result.warnings) console.log(`  warning: ${w}`);
        console.table(action.result.summary);
        table(action.result.lines.map(({ txHashes: _, ...line }) => line));
      }
      break;
    }
    case "actions":
      table(
        workspace()
          .actions(need(a, "asset"))
          .map((x) => ({ id: x.id, label: x.label, record: x.recordTime, state: x.state, openBreaks: x.openBreaks })),
      );
      break;
    case "controls": {
      const log = workspace().controls(need(a, "asset"));
      if (values.json) return out(log);
      console.table(log.summary);
      table(
        log.records.map((r) => ({
          time: r.closedAt,
          type: r.type,
          account: r.account,
          units: r.units ?? "",
          instruction: r.instruction?.ref ?? "— none —",
        })),
      );
      break;
    }
    case "export": {
      const concord = workspace();
      const asset = need(a, "asset");
      const period: { from?: string; to?: string } = {};
      if (values.from) period.from = values.from;
      if (values.to) period.to = values.to;
      const text = values.csv
        ? concord.exportCsv(asset, values.csv, period)
        : JSON.stringify(concord.auditExport(asset, period), null, 2);
      if (values.out) {
        writeFileSync(values.out, text);
        console.log(`wrote ${values.out}`);
      } else {
        process.stdout.write(text);
      }
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
  runtime.close();
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
