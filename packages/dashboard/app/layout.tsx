export const metadata = {
  title: "pros dashboard",
  description: "ProsHarness operator console -- runs, plans, questions",
};

// Deliberately plain: an internal operator tool, not a product. Inline
// styles only, no component library, no Tailwind setup -- per the brief.
const globalStyle = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 0;
    color: #1a1a1a;
    background: #fafafa;
  }
  a { color: #0645ad; }
  nav {
    padding: 12px 20px;
    background: #222;
    color: white;
  }
  nav a { color: #ddd; margin-right: 16px; text-decoration: none; }
  nav a:hover { color: white; text-decoration: underline; }
  main { padding: 20px; max-width: 1000px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; font-size: 14px; }
  th { background: #eee; }
  .warning-banner {
    background: #fff3cd;
    border: 2px solid #d9822b;
    color: #6b4a00;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-weight: bold;
    border-radius: 4px;
  }
  .error-banner {
    background: #fde2e2;
    border: 2px solid #c0392b;
    color: #7a1f1f;
    padding: 12px 16px;
    margin-bottom: 16px;
    border-radius: 4px;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: bold;
    background: #e0e0e0;
  }
  .badge.parked { background: #ffe6a7; }
  .badge.running { background: #c8f0c8; }
  .badge.done { background: #d8d8d8; }
  .badge.idle { background: #eee; }
  .badge.pass { background: #c8f0c8; }
  .badge.fail { background: #fde2e2; }
  pre.plan-markdown {
    white-space: pre-wrap;
    background: #fff;
    border: 1px solid #ddd;
    padding: 12px;
    border-radius: 4px;
    font-size: 13px;
  }
  textarea { font-family: monospace; font-size: 13px; }
  button { cursor: pointer; padding: 6px 14px; margin-right: 8px; }
  code { background: #eee; padding: 1px 4px; border-radius: 3px; }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: globalStyle }} />
      </head>
      <body>
        <nav>
          <a href="/runs">Runs</a>
          <a href="/loops">Loops</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
