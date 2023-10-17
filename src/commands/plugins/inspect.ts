import {Args, Command, Flags, Plugin, ux} from '@oclif/core'
import chalk from 'chalk'
import {readFile} from 'node:fs/promises'
import * as path from 'node:path'

import Plugins from '../../plugins.js'
import {sortBy} from '../../util.js'

function trimUntil(fsPath: string, part: string): string {
  const parts = fsPath.split(path.sep)
  // eslint-disable-next-line unicorn/no-array-reduce
  const indices = parts.reduce((a, e, i) => (e === part ? [...a, i] : a), [] as number[])
  const partIndex = Math.max(...indices)
  if (partIndex === -1) return fsPath
  return parts.slice(0, partIndex + 1).join(path.sep)
}

type Dependencies = Record<string, {from: string; version: string}>
type PluginWithDeps = Plugin & {deps: Dependencies}

export default class PluginsInspect extends Command {
  static args = {
    plugin: Args.string({
      default: '.',
      description: 'Plugin to inspect.',
      required: true,
    }),
  }

  static description = 'Displays installation properties of a plugin.'

  static enableJsonFlag = true

  static examples = ['$ <%= config.bin %> plugins:inspect <%- config.pjson.oclif.examplePlugin || "myplugin" %> ']

  static flags = {
    help: Flags.help({char: 'h'}),
    verbose: Flags.boolean({char: 'v'}),
  }

  static strict = false

  static usage = 'plugins:inspect PLUGIN...'

  plugins = new Plugins(this.config)

  // In this case we want these operations to happen
  // sequentially so the `no-await-in-loop` rule is ignored
  async findDep(plugin: Plugin, dependency: string): Promise<{pkgPath: null | string; version: null | string}> {
    const dependencyPath = path.join(...dependency.split('/'))
    let start = path.join(plugin.root, 'node_modules')
    const paths = [start]
    while ((start.match(/node_modules/g) || []).length > 1) {
      start = trimUntil(path.dirname(start), 'node_modules')
      paths.push(start)
    }

    // TODO: use promise.any to check the paths in parallel
    // requires node >= 16
    for (const p of paths) {
      const fullPath = path.join(p, dependencyPath)
      const pkgJsonPath = path.join(fullPath, 'package.json')
      try {
        // eslint-disable-next-line no-await-in-loop
        const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
        return {pkgPath: fullPath, version: pkgJson.version as string}
      } catch {
        // try the next path
      }
    }

    return {pkgPath: null, version: null}
  }

  findPlugin(pluginName: string): Plugin {
    const pluginConfig = this.config.getPluginsList().find((plg) => plg.name === pluginName)

    if (pluginConfig) return pluginConfig as Plugin
    if (this.config.pjson.oclif.jitPlugins?.[pluginName]) {
      this.warn(
        `Plugin ${pluginName} is a JIT plugin. It will be installed the first time you run one of it's commands.`,
      )
    }

    throw new Error(`${pluginName} not installed`)
  }

  async inspect(pluginName: string, verbose = false): Promise<PluginWithDeps> {
    const plugin = this.findPlugin(pluginName)
    const tree = ux.tree()
    const pluginHeader = chalk.bold.cyan(plugin.name)
    tree.insert(pluginHeader)
    tree.nodes[pluginHeader].insert(`version ${plugin.version}`)
    if (plugin.tag) tree.nodes[pluginHeader].insert(`tag ${plugin.tag}`)
    if (plugin.pjson.homepage) tree.nodes[pluginHeader].insert(`homepage ${plugin.pjson.homepage}`)
    tree.nodes[pluginHeader].insert(`location ${plugin.root}`)

    tree.nodes[pluginHeader].insert('commands')
    const commands = sortBy(plugin.commandIDs, (c) => c)
    for (const cmd of commands) tree.nodes[pluginHeader].nodes.commands.insert(cmd)

    const dependencies = {...plugin.pjson.dependencies}

    tree.nodes[pluginHeader].insert('dependencies')
    const deps = sortBy(Object.keys(dependencies), (d) => d)
    const depsJson: Dependencies = {}
    for (const dep of deps) {
      // eslint-disable-next-line no-await-in-loop
      const {pkgPath, version} = await this.findDep(plugin, dep)
      if (!version) continue

      const from = dependencies[dep] ?? null
      const versionMsg = chalk.dim(from ? `${from} => ${version}` : version)
      const msg = verbose ? `${dep} ${versionMsg} ${pkgPath}` : `${dep} ${versionMsg}`

      tree.nodes[pluginHeader].nodes.dependencies.insert(msg)
      depsJson[dep] = {from, version}
    }

    if (!this.jsonEnabled()) tree.display()

    return {...plugin, deps: depsJson} as PluginWithDeps
  }

  async parsePluginName(input: string): Promise<string> {
    if (input.includes('@') && input.includes('/')) {
      input = input.slice(1)
      const [name] = input.split('@')
      return '@' + name
    }

    const [splitName] = input.split('@')
    const name = await this.plugins.maybeUnfriendlyName(splitName)
    return name
  }

  /* eslint-disable no-await-in-loop */
  async run(): Promise<PluginWithDeps[]> {
    const {argv, flags} = await this.parse(PluginsInspect)
    if (flags.verbose) this.plugins.verbose = true
    const aliases = this.config.pjson.oclif.aliases || {}
    const plugins: PluginWithDeps[] = []
    for (let name of argv as string[]) {
      if (name === '.') {
        const pkgJson = JSON.parse(await readFile('package.json', 'utf8'))
        name = pkgJson.name
      }

      if (aliases[name] === null) this.error(`${name} is blocked`)
      name = aliases[name] || name
      const pluginName = await this.parsePluginName(name)

      try {
        plugins.push(await this.inspect(pluginName, flags.verbose))
      } catch (error) {
        this.log(chalk.bold.red('failed'))
        throw error
      }
    }

    return plugins
  }
}
