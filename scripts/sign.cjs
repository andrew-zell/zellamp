// electron-builder afterSign hook.
//
// Ad-hoc signatures are pinned to the build's hash, so macOS privacy
// permissions (Automation, Screen & System Audio Recording) go stale on
// every rebuild. If a local code-signing certificate named
// "Zellamp Local Signing" exists, re-sign with it: the app's identity is
// then tied to that certificate and permissions survive rebuilds.
// (Create it once in Keychain Access, see README "Stable permissions".)
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const IDENTITY_NAME = 'Zellamp Local Signing'

function findIdentity() {
  // No -v: a self-signed certificate is "not trusted" but signs fine.
  const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
  const line = out.split('\n').find((l) => l.includes(`"${IDENTITY_NAME}"`))
  return line?.match(/\b([0-9A-F]{40})\b/)?.[1] ?? null
}

exports.default = async function afterSign({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return
  const identity = findIdentity()
  if (!identity) {
    console.log(`  • "${IDENTITY_NAME}" not found: keeping ad-hoc signature (permissions reset on rebuild)`)
    return
  }
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  const entitlements = path.join(__dirname, '../resources/entitlements.mac.plist')
  execFileSync(
    'codesign',
    ['--force', '--deep', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, app],
    { stdio: 'inherit' },
  )
  console.log(`  • re-signed with "${IDENTITY_NAME}" (stable identity)`)
}
