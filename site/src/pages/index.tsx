import type { RouteConfig } from 'fumapress'
import { Terminal } from '../components/terminal'
import { CopyCommand } from '../components/copy-command'
import { Glyph } from '../components/glyph'
import { STATE_NOTES } from '../lib/states'

export async function getConfig() {
  return { render: 'static' } satisfies RouteConfig
}

const SSH_INCANTATION = `ssh -N -o ExitOnForwardFailure=yes \\
  -L 127.0.0.1:3000:localhost:3000 \\
  -L 127.0.0.1:3010:localhost:3010 \\
  -L 127.0.0.1:8080:localhost:8080 \\
  10.0.0.7`

const SYNTAX = [
  ['3000', 'localhost:3000 → remote localhost:3000'],
  ['8080:80', 'localhost:8080 → remote localhost:80'],
  ['8080:db.internal:5432', 'localhost:8080 → db.internal:5432, reached from the ssh host'],
  ['3000-3005', 'six forwards, same port on both ends'],
  ['8000-8002:9000-9002', 'paired ranges, zipped in order'],
  ['5432:[::1]:5432', 'IPv6 literals, bracketed']
]

const SESSION_TRANSCRIPT = `$ mirb -b --name api 10.0.0.7 5432 6379 8080
  an8ioa  10.0.0.7  ready
  stop it with: mirb stop an8ioa

$ mirb ls
  ID      NAME  HOST      FORWARDS                    UP  STATUS
  an8ioa  api   10.0.0.7  5432 ← 5432, 6379 ← 6379    8s  ● ready

$ mirb logs api -f
$ mirb stop an8ioa          # or: mirb stop --all`

const COMPARISON = {
  cols: ['mirrorball', 'ssh -L', 'autossh', 'sshuttle'],
  rows: [
    ['What it does', 'wraps ssh -L', 'port forwarding', 'keeps an ssh alive', 'transparent subnet routing'],
    ['Many ports in one argument list', '3000 3010 8080', 'one -L each', 'via ssh args', 'subnets, not ports'],
    ['Ranges and port mappings', '3000-3005, 8080:80', 'by hand, one each', 'via ssh args', 'n/a'],
    ['Manage running tunnels', 'ls / stop / logs', 'none', 'none', 'pidfile with -D'],
    ['Reconnects', 'backoff + jitter', 'no', 'yes, its whole purpose', 'yes'],
    ['Tells bound from ready from refused', 'yes', 'no', 'no', 'no per-port model'],
    ['Machine-readable output', 'NDJSON + JSON', 'no', 'no', 'no'],
    ['Needs root', 'no', 'no', 'no', 'yes, for firewall rules'],
    ['Needs anything on the remote', 'no', 'no', 'no', 'yes, Python 3']
  ]
}

export default function Home() {
  return (
    <main className="landing">
      {/* React 19 hoists these into <head>. Content pages get their metadata from
          frontmatter; a file-based route has none, so without this the landing page
          ships with no title at all and shows up as a bare URL in a tab or a search
          result. */}
      <title>mirrorball — instant SSH port forwarding</title>
      <meta
        name="description"
        content="Forward any number of ports over SSH with one command. mirb 10.0.0.7 3000 3010 8080 instead of an ssh -L incantation, over the ssh you already have configured."
      />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="https://mirb.dev/" />
      <meta property="og:title" content="mirrorball — instant SSH port forwarding" />
      <meta
        property="og:description"
        content="One command instead of an ssh -L incantation. Bare ports, mappings and ranges, over the ssh you already have configured."
      />
      <meta name="twitter:card" content="summary" />

      {/* ---------------------------------------------------------------- hero */}
      <section className="hero">
        <p className="eyebrow">ssh port forwarding</p>

        <h1 className="hero-title">
          Port forwarding you can
          <br />
          <span className="hero-title-alt">type from memory.</span>
        </h1>

        <p className="hero-sub">
          One command instead of an <code>ssh -L</code> incantation — over the same{' '}
          <code>ssh</code> you already have configured. However many ports you need, in one
          argument list.
        </p>

        <div className="swap">
          <figure className="swap-side swap-before">
            <figcaption className="swap-label">What you have been typing</figcaption>
            <pre className="swap-code">
              <code>{SSH_INCANTATION}</code>
            </pre>
          </figure>

          <figure className="swap-side swap-after">
            <figcaption className="swap-label">mirrorball</figcaption>
            <pre className="swap-code swap-code-after">
              <code>mirb 10.0.0.7 3000 3010 8080</code>
            </pre>
            <p className="swap-note">
              No <code>-L</code>, no bind addresses, no backslashes. Add a port by typing a
              number.
            </p>
          </figure>
        </div>

        <div className="hero-cta">
          <CopyCommand command="curl -fsSL https://mirb.dev/install.sh | sh" />
          <a className="btn-secondary" href="/docs">
            Read the docs
          </a>
        </div>

        <p className="hero-note">
          Wraps the system <code>ssh</code>, so your <code>~/.ssh/config</code> aliases,{' '}
          <code>ProxyJump</code>, agent forwarding and hardware keys all apply untouched.
          Nothing to install on the remote host.
        </p>
      </section>

      {/* ------------------------------------------------------------- running */}
      <section className="section">
        <h2 className="section-title">What it looks like running</h2>
        <p className="section-lede">
          One line per forward, so you can see at a glance that the ports you asked for are
          the ports you got.
        </p>
        <Terminal />
      </section>

      {/* -------------------------------------------------------------- syntax */}
      <section className="section">
        <h2 className="section-title">Bare ports, mappings, ranges</h2>
        <p className="section-lede">
          The first field is always the local port. Everything else is optional.
        </p>

        <div className="table-scroll">
          <table className="syntax">
            <thead>
              <tr>
                <th scope="col">You write</th>
                <th scope="col">mirrorball forwards</th>
              </tr>
            </thead>
            <tbody>
              {SYNTAX.map(([wrote, forwards]) => (
                <tr key={wrote}>
                  <td>
                    <code>{wrote}</code>
                  </td>
                  <td>{forwards}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="section-foot">
          Forwards bind to <code>127.0.0.1</code>. Binding anywhere else would publish the
          service to your whole network, so mirrorball refuses unless you also pass{' '}
          <code>--expose</code>. Full grammar in{' '}
          <a href="/docs/guides/port-syntax">Port syntax</a>.
        </p>
      </section>

      {/* ------------------------------------------------------------ sessions */}
      <section className="section">
        <h2 className="section-title">Leave it running, then stop it by name</h2>
        <p className="section-lede">
          <code>--background</code> detaches a supervisor and waits for the tunnel to prove
          itself before returning, so the ports are listening by the time you get your prompt
          back.
        </p>

        <pre className="transcript">
          <code>{SESSION_TRANSCRIPT}</code>
        </pre>

        <p className="section-foot">
          There is no daemon. Each session is a detached <code>mirb</code> supervising one{' '}
          <code>ssh</code>, its state a JSON file under <code>~/.local/state/mirb</code>. A
          record whose supervisor is gone is pruned the next time you run <code>mirb ls</code>.
        </p>
      </section>

      {/* --------------------------------------------------------------- states */}
      <section className="section">
        <h2 className="section-title">And it tells you when the far end is down</h2>
        <p className="section-lede">
          <code>ssh -L</code> binds your local port whether or not anything is listening on
          the other side, so a dead service looks exactly like a working one until your first
          request hangs. mirrorball probes each forward and labels it.
        </p>

        <ul className="states">
          {STATE_NOTES.map((note) => (
            <li className="state" key={note.label} data-state={note.state}>
              <span className="state-glyph">
                <Glyph state={note.state} />
              </span>
              <h3 className="state-label">{note.label}</h3>
              <p className="state-meaning">{note.meaning}</p>
              <p className="state-fixer">{note.fixer}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------ comparison */}
      <section className="section">
        <h2 className="section-title">Compared to</h2>
        <div className="table-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col" className="compare-rowhead" />
                {COMPARISON.cols.map((c, i) => (
                  <th scope="col" key={c} className={i === 0 ? 'compare-mine' : undefined}>
                    <code>{c}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON.rows.map((row) => (
                <tr key={row[0]}>
                  <th scope="row" className="compare-rowhead">
                    {row[0]}
                  </th>
                  {row.slice(1).map((cell, i) => (
                    <td key={i} className={i === 0 ? 'compare-mine' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="section-foot">
          <strong>autossh</strong> solves reconnection, and only reconnection — for a permanent
          tunnel under systemd it is still an excellent answer. <strong>sshuttle</strong> routes
          whole subnets like a VPN, which is what you want when you do not know in advance which
          addresses you will need; it costs local root and a Python interpreter on the remote.
          mirrorball forwards ports you can name, and needs neither.
        </p>
      </section>

      {/* ------------------------------------------------------------------ next */}
      <section className="section section-last">
        <h2 className="section-title">Start here</h2>
        <ul className="next">
          <li>
            <a href="/docs/getting-started/quick-start">Quick start</a>
            <span>Your first tunnel, start to finish</span>
          </li>
          <li>
            <a href="/docs/guides/port-syntax">Port syntax</a>
            <span>Every form mirrorball accepts, and what each expands to</span>
          </li>
          <li>
            <a href="/docs/reference/cli">CLI reference</a>
            <span>Every command and flag</span>
          </li>
          <li>
            <a href="/docs/guides/troubleshooting">Troubleshooting</a>
            <span>When it says refused, failed, or nothing at all</span>
          </li>
        </ul>
      </section>
    </main>
  )
}
