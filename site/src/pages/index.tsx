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

const COMPARISON = {
  cols: ['mirrorball', 'ssh -L', 'autossh', 'sshuttle'],
  rows: [
    ['What it does', 'wraps ssh -L', 'port forwarding', 'keeps an ssh alive', 'transparent subnet routing'],
    ['Tells bound from ready from refused', 'yes', 'no', 'no', 'no per-port model'],
    ['Many ports in one argument list', '3000 3010 8080', 'one -L each', 'via ssh args', 'subnets, not ports'],
    ['Reconnects', 'backoff + jitter', 'no', 'yes, its whole purpose', 'yes'],
    ['Manage running tunnels', 'ls / stop / logs', 'none', 'none', 'pidfile with -D'],
    ['Machine-readable output', 'NDJSON + JSON', 'no', 'no', 'no'],
    ['Needs root', 'no', 'no', 'no', 'yes, for firewall rules'],
    ['Needs anything on the remote', 'no', 'no', 'no', 'yes, Python 3']
  ]
}

export default function Home() {
  return (
    <main className="landing">
      {/* ---------------------------------------------------------------- hero */}
      <section className="hero">
        <p className="eyebrow">ssh port forwarding</p>

        <h1 className="hero-title">
          The tunnel is fine.
          <br />
          <span className="hero-title-alt">The service is down.</span>
        </h1>

        <p className="hero-sub">
          <code>ssh -L</code> binds your local port either way, and says nothing. mirrorball
          probes the far end of every forward and tells you which one you are looking at.
        </p>

        <Terminal />

        <div className="hero-cta">
          <CopyCommand command="curl -fsSL https://mirb.dev/install.sh | sh" />
          <a className="btn-secondary" href="/docs">
            Read the docs
          </a>
        </div>

        <p className="hero-note">
          Wraps the system <code>ssh</code>, so your <code>~/.ssh/config</code> aliases,{' '}
          <code>ProxyJump</code>, agent forwarding and hardware keys all apply untouched.
        </p>
      </section>

      {/* ------------------------------------------------------------ before/after */}
      <section className="section">
        <h2 className="section-title">One command instead of an incantation</h2>

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
              Bare ports mean the same port on both ends. <code>8080:80</code> maps across,
              and <code>3000-3010</code> is a range.
            </p>
          </figure>
        </div>
      </section>

      {/* --------------------------------------------------------------- states */}
      <section className="section">
        <h2 className="section-title">Four states, and who fixes each one</h2>
        <p className="section-lede">
          <code>refused</code> and <code>failed</code> are the distinction the whole tool
          exists for. One means your app is not running. The other means your tunnel never
          came up. Reading them as the same thing is what costs you the afternoon.
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
            <a href="/docs/getting-started/concepts">Concepts</a>
            <span>Targets, forwards, sessions, readiness states</span>
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
