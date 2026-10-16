import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function launchAgent({ node, releaseDirectory, configPath, stateDirectory }) {
  if (![node, releaseDirectory, configPath, stateDirectory].every(x => typeof x === 'string' && x.startsWith('/') && !/[\r\n\0]/.test(x))) throw new Error('DESKTOP_CONFIG_INVALID');
  const args = [node, `${releaseDirectory}/lib/desktop-runner.js`, 'tick', '--config', configPath].map(x => `<string>${xml(x)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>it.jimdoes.georgiawoodtools.publisher</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(releaseDirectory)}</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(stateDirectory)}/runner.log</string>
<key>StandardErrorPath</key><string>${xml(stateDirectory)}/runner-error.log</string>
</dict></plist>\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(launchAgent(JSON.parse(process.argv[2])));
