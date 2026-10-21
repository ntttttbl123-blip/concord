/**
 * The CLI's help text. Kept in its own module so the tests can import it without
 * pulling in the rest of the CLI (which opens databases when run), and so the
 * drift test in test/service.test.ts can hold the README's examples against it.
 */
export const USAGE = `concord — reconcile tokenized securities on Stellar against the register

Workspace commands. Name the workspace with --org <id | exact name> or CONCORD_ORG.

  watch <CODE:ISSUER | CONTRACT>   start indexing an asset
        [--network mainnet|testnet] [--name N] [--ignore A,B]
        [--from LEDGER] [--no-baseline] [--decimals D]
  unwatch ASSET                    stop watching; deletes the asset and its books
  rebuild ASSET                    re-index from fresh opening balances; books stay
  assets                           list watched assets
  sync [ASSET]                     pull new events (every workspace when no --org)
  holdings ASSET [--as-of ISO]     on-chain holders
  register ASSET FILE --as-of ISO  import a register export and reconcile it
  journal ASSET FILE               import the register's transaction journal
  instructions ASSET FILE          import control instructions
  reconcile ASSET [--register ID]  re-run a reconciliation
  action ASSET dividend --record ISO --rate R [--pay-asset A] [--payer G...] [--until ISO]
  action ASSET split|redemption --record ISO --ratio NUM:DEN [--until ISO]
        [--label TEXT] [--exclude A,B]
  actions ASSET                    corporate actions and their state
  controls ASSET                   freeze, authorisation and clawback log
  export ASSET [--from ISO] [--to ISO] [--csv SECTION] [--out FILE]

Operator commands.

  orgs                             list workspaces
  signup-code [--note TEXT]        a code that lets one new workspace be created (CONCORD_SIGNUP=code)
  reset-link EMAIL                 a one-day link for setting a new password
  org-delete ORG                   delete a workspace and everything in it
  backup DIR                       copy every database to DIR while the server runs
  serve                            run the API and dashboard

ASSET is a code or a contract id. Add --json to most commands for machine-readable output,
or --help (-h) to see this text. Settings come from the environment; see .env.example.`;
