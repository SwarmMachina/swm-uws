import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

export function getNpmInvocation(
  args,
  { environment = process.env, nodePath = process.execPath, platform = process.platform } = {}
) {
  if (environment.npm_execpath) {
    return {
      executable: nodePath,
      args: [environment.npm_execpath, ...args]
    }
  }

  if (platform === 'win32') {
    return {
      executable: nodePath,
      args: [win32.join(win32.dirname(nodePath), 'node_modules/npm/bin/npm-cli.js'), ...args]
    }
  }

  return {
    executable: 'npm',
    args: [...args]
  }
}

export function execNpmSync(args, options) {
  const invocation = getNpmInvocation(args)

  return execFileSync(invocation.executable, invocation.args, options)
}
