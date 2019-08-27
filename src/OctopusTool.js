import parseArgs from "minimist"
import * as version from "./version"
import readlinePassword from "@johnls/readline-password"
import SSH2Promise from "ssh2-promise"
import os from "os"
import fs from "fs-extra"
import vm from "vm"
import path from "path"
import { Readable } from "stream"
import JSON5 from "@johnls/json5"
import autobind from "autobind-decorator"
import * as asserters from "./asserters"
import * as util from "./util"
import { ScriptError } from "./ScriptError"

@autobind
export class OctopusTool {
  constructor(container) {
    this.toolName = container.toolName
    this.log = container.log
    this.debug = container.debug
  }

  static installNodeScript = `#!/bin/bash
curl -sL https://deb.nodesource.com/setup_10.x -o ./nodesource_setup.sh
sudo bash ./nodesource_setup.sh
sudo apt -y -q install nodejs`
  static minNodeVersion = "v10"

  async assertCanSudoOnHost(ssh) {
    const result = await util.runRemoteCommand(ssh, "bash -c 'echo /$EUID'", {
      sudo: true,
      password: ssh.config[0].password,
      noThrow: true,
    })

    if (result.exitCode !== 0 || result.output !== "/0") {
      throw new Error(
        `User ${ssh.config[0].username} does not have sudo ability on remote system`
      )
    }
    return true
  }

  // Assert the remote system has Node 10 installed
  async assertHasNode(ssh) {
    let result = await util.runRemoteCommand(ssh, "node --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 &&
      result.output.trim().startsWith(OctopusTool.minNodeVersion)
    )
  }

  async rectifyHasNode(ssh) {
    const password = ssh.config[0].password
    let result = null

    this.log.info("Checking remote system clock")
    result = await util.runRemoteCommand(ssh, 'bash -c "echo /$(date)"', {
      noThrow: true,
    })

    if (result.exitCode !== 0 || !result.output.startsWith("/")) {
      throw new Error("Unable to get remote host date & time")
    }

    const remoteDate = new Date(result.output.substring(1))
    const localDate = new Date()

    if (
      remoteDate.getFullYear() !== localDate.getFullYear() ||
      remoteDate.getMonth() !== localDate.getMonth() ||
      remoteDate.getDate() !== localDate.getDate()
    ) {
      throw new Error("Remote system clock is more than 24 hours out of sync.")
    }

    this.assertCanSudoOnHost(ssh)

    this.log.info("Creating /opt/octopus directory")
    await util.runRemoteCommand(ssh, "mkdir -p /opt/octopus", {
      sudo: true,
      password,
    })

    this.log.info("Creating /opt/octopus/install_node.sh script")
    await util.runRemoteCommand(
      ssh,
      `bash -c 'echo "${OctopusTool.installNodeScript}" > ./install_node.sh'`,
      {
        cwd: "/opt/octopus",
        sudo: true,
        password,
      }
    )

    this.log.info("Running /opt/octopus/install_node.sh script")
    result = await util.runRemoteCommand(ssh, "bash ./install_node.sh", {
      cwd: "/opt/octopus",
      sudo: true,
      password,
      noThrow: true,
    })

    if (result.exitCode !== 0) {
      // If the Node install fails it may just need an upgrade
      this.log.info("Trying to upgrade Node.js")
      result = await util.runRemoteCommand(ssh, "apt install -y nodejs", {
        cwd: "/opt/octopus",
        sudo: true,
        password,
      })
    }

    result = await util.runRemoteCommand(ssh, "node --version", {
      noThrow: true,
    })

    if (
      result.exitCode !== 0 ||
      !result.output.trim().startsWith(OctopusTool.minNodeVersion)
    ) {
      throw new Error(
        `Unable to install Node.js ${OctopusTool.minNodeVersion} on remote host`
      )
    }
  }

  async assertHasOctopus(ssh) {
    let result = await util.runRemoteCommand(ssh, "octopus --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 && result.output.trim().startsWith(version.version)
    )
  }

  async rectifyHasOctopus(ssh, options = {}) {
    if (!options.canSudoOnHost) {
      this.assertCanSudoOnHost(ssh)
    }

    const password = ssh.config[0].password

    this.log.info("Installing Octopus")
    await util.runRemoteCommand(ssh, "npm install -g @johnls/octopus", {
      sudo: true,
      password,
    })

    const result = await util.runRemoteCommand(ssh, "octopus --version", {
      noThrow: true,
    })

    if (
      result.exitCode !== 0 ||
      !result.output.trim().startsWith(version.version)
    ) {
      throw new Error(
        `Unable to install Octopus ${version.version} on remote host`
      )
    }
  }

  async readScriptFile(scriptFile) {
    const scriptNodes = JSON5.parse(await fs.readFile(scriptFile), {
      wantNodes: true,
      addFilename: true,
    })

    if (scriptNodes.type !== "object") {
      throw new ScriptError(
        "Script must have an object as the root",
        scriptNodes
      )
    }

    const {
      includes: includesNode,
      options: optionsNode,
      vars: varsNode,
      assertions: assertionsNode,
    } = scriptNodes.value

    if (includesNode) {
      if (scriptNodes.type !== "array") {
        throw new ScriptError("'include' must be an array", scriptNodes)
      }

      for (const includeNode of includesNode.value) {
        if (includeNode.type !== "string") {
          throw new ScriptError(
            "'include' array item must be a string",
            includeNode
          )
        }
      }
    }

    if (optionsNode) {
      if (optionsNode.type !== "object") {
        throw new ScriptError("'options' must be an object", optionsNode)
      }

      const { description: descriptionNode } = optionsNode.value

      if (descriptionNode) {
        if (descriptionNode.type !== "string") {
          throw new ScriptError(
            "'options.description' must be a string",
            descriptionNode
          )
        }
      }
    }

    if (varsNode) {
      if (varsNode.type !== "object") {
        throw new ScriptError("'vars' must be an object", varsNode)
      }

      switch (varNode.type) {
        case "null":
        case "numeric":
        case "boolean":
        case "string":
          break
        case "object":
          const valueNode = varNode.value.value

          if (!valueNode || valueNode.type !== "string") {
            throw new ScriptError(
              `Variable object must have value field of type string`,
              varNode
            )
          }
          break
        default:
          throw new ScriptError(
            `Variable of type ${varNode.type} is invalid`,
            varNode
          )
      }
    }

    if (assertionsNode) {
      if (assertionsNode.type !== "array") {
        throw new ScriptError("'assertions' must be an array", assertionsNode)
      }

      for (const assertionNode of assertionsNode.value) {
        if (assertionNode.type !== "object") {
          throw new ScriptError("Assertion must be an object", assertionNode)
        }

        const {
          description: descriptionNode,
          assert: assertNode,
          with: withNode,
        } = assertionNode.value

        if (assertNode) {
          if (assertNode.type !== "string") {
            throw new ScriptError("'assert' must be a string", assertNode)
          }
        } else {
          throw new ScriptError("'assert' property is not present", assertNode)
        }

        if (descriptionNode) {
          if (descriptionNode.type !== "string") {
            throw new ScriptError(
              "'description' must be a string",
              descriptionNode
            )
          }
        }

        if (withNode) {
          if (withNode.type !== "object") {
            throw new ScriptError("'with' must be an object", withNode)
          }
        }
      }
    }

    return {
      includes: includesNode,
      options: optionsNode,
      vars: varsNode,
      assertions: assertionsNode,
    }
  }

  async mergeIncludeNodes(scriptNodes) {
    const { includes: includesNode } = scriptNodes

    if (!includesNode) {
      return scriptNodes
    }

    const scriptDir = path.dirname(scriptNodes.filename)

    for (const includeNode of includesNodes) {
      const fullScriptPath = path.resolve(scriptDir, path)

      try {
        const newScriptNodes = await this.readScriptFile(fullScriptPath)

        scriptNodes = this.mergeIncludeNodes(
          scriptNodes,
          newScriptNodes.includesNodes
        )

        scriptNodes.options.concat(newScriptNodes.options)
        scriptNodes.vars.concat(newScriptNodes.vars)
        scriptNodes.assertions.concat(newScriptNodes.assertions)
      } catch (e) {
        throw new ScriptError(`Cannot read script - ${e.message}`, includeNode)
      }
    }

    return scriptNodes
  }

  async compileScriptFile(scriptFile, options = {}) {
    const { runningOnOrigin } = options
    const fullScriptFile = path.resolve(scriptFile)
    const vmContext = {
      env: process.env,
      sys: {
        SCRIPT_FILE: fullScriptFile,
        SCRIPT_DIR: path.dirname(fullScriptFile),
      },
      fs: {
        readFile: (fileName) => fs.readFileSync(fileName),
      },
      path: {
        join: (...paths) => path.join(...paths),
      },
    }
    const expandStringNode = (node) => {
      if (
        !node.value ||
        !node.type ||
        node.type !== "string" ||
        !node.line ||
        !node.column
      ) {
        throw new Error("Must pass in a string node to expand")
      }

      try {
        return new vm.Script("`" + node.value + "`").runInContext(
          vm.createContext(vmContext)
        )
      } catch (e) {
        throw new ScriptError(e.message, node)
      }
    }
    let scriptNodes = null

    try {
      scriptNodes = this.readScriptFile(scriptFile)
    } catch (e) {
      throw new Error(`Unable to read script file ${fullScriptFile}`)
    }

    const {
      includes: includesNode,
      vars: varsNode,
      assertions: assertionsNode,
    } = scriptNodes

    scriptNodes = this.mergeIncludeNodes(scriptNodes)
    scriptNodes.includes = null

    if (varsNode) {
      for (const [key, varNode] of Object.entries(varsNode.value)) {
        if (vmContext[key] && typeof vmContext[key] === "object") {
          throw new ScriptError(
            `Variable ${key} conflicts with a built-in object`,
            varNode
          )
        }

        switch (varNode.type) {
          case "null":
            delete vmContext[key]
            break
          case "numeric":
          case "boolean":
            vmContext[key] = varNode.value.toString()
            break
          case "string":
            vmContext[key] = varNode.value
            break
          case "object":
            const valueNode = varNode.value.value

            if (runningOnOrigin && varNode.value.origin) {
              vmContext[key] = expandStringNode(valueNode)
            }
            break
        }
      }
    }

    let assertions = []

    if (assertionsNode) {
      for (const assertionNode of assertionsNode.value) {
        const assertion = {}
        const {
          description: descriptionNode,
          assert: assertNode,
          with: withNode,
        } = assertionNode.value

        assertion.assertNode = assertNode
        assertion.withNode = withNode
        assertion.name = assertNode.value

        if (descriptionNode) {
          assertion.description = descriptionNode.value
        }

        if (withNode) {
          assertion.args = withNode.value
        }

        assertions.push(assertion)
      }
    }

    return {
      script: JSON5.simplify(scriptNodes),
      assertions,
      vmContext,
      expandStringNode,
    }
  }

  async runScriptLocally(scriptFile, options) {
    const state = await this.compileScriptFile(scriptFile)
    const { script, assertions, vmContext, expandStringNode } = state

    if (options.verbose) {
      const vars = {}

      Object.keys(vmContext).forEach((key) => {
        if (
          key === "env" ||
          key === "sys" ||
          typeof vmContext[key] !== "object"
        ) {
          vars[key] = vmContext[key]
        }
      })
      this.log.info(JSON5.stringify(vars, null, "  "))
    }

    if (options && options.description) {
      this.log.output(
        JSON5.stringify({ description: script.options.description })
      )
    }

    for (const assertion of assertions) {
      const asserter = new asserters[assertion.name]({
        expandStringNode,
        assertNode: assertion.assertNode,
        withNode: assertion.withNode,
      })

      let ok = await asserter.assert(assertion.args)
      let output = {}

      if (!ok) {
        await asserter.rectify()

        output.rectified = assertion.name
      } else {
        output.asserted = assertion.name
      }

      if (assertion.description) {
        output.description = assertion.description
      }

      output.result = asserter.result()
      this.log.output(JSON5.stringify(output))
    }

    return 0
  }

  async runScriptRemotely(scriptFile, options) {
    let isConnected = false
    let ssh = null
    let remoteTempFile = null

    const showPrompts = async (name, instructions, lang, prompts) => {
      const rl = readlinePassword.createInstance(process.stdin, process.stdout)
      let responses = []

      for (const prompt of prompts) {
        responses.push(await rl.passwordAsync(prompt))
      }
      rl.close()
      return responses
    }

    try {
      const userInfo = os.userInfo()
      const sshConfig = {
        username: options.user || userInfo.username,
        host: options.host || "localhost",
        port: options.port || 22,
        password: options.password,
        agent: process.env["SSH_AUTH_SOCK"],
        showPrompts,
        //debug: this.debug ? (detail) => this.log.info(detail) : null,
      }

      this.log.info(
        `Connecting to ${sshConfig.host}:${sshConfig.port} as ${sshConfig.username}`
      )

      if (!sshConfig.password) {
        const answers = await showPrompts("", "", "en-us", [
          {
            prompt: `${sshConfig.username}:${sshConfig.host}'s password:`,
            echo: false,
          },
        ])

        sshConfig.password = answers[0]
      }

      ssh = new SSH2Promise(sshConfig)

      await ssh.connect()

      isConnected = true

      this.log.info(`Connected to ${sshConfig.host}:${sshConfig.port}`)

      let installedNode = false

      if (!(await this.assertHasNode(ssh))) {
        this.log.warning(
          `Node not found on ${sshConfig.host}:${sshConfig.port}; attempting to rectify.`
        )
        await this.rectifyHasNode(ssh)
        installedNode = true
      } else if (options.verbose) {
        this.log.info(
          `Node.js is installed on ${sshConfig.host}:${sshConfig.port}`
        )
      }

      if (!(await this.assertHasOctopus(ssh))) {
        this.log.warning(
          `Octopus with version ${version.version} not found on ${sshConfig.host}:${sshConfig.port}; attempting to rectify`
        )
        await this.rectifyHasOctopus(ssh, { canSudoOnHost: installedNode })
      } else if (options.verbose) {
        this.log.info(
          `Octopus is installed on ${sshConfig.host}:${sshConfig.port}`
        )
      }

      remoteTempFile = (await util.runRemoteCommand(
        ssh,
        "mktemp"
      )).output.trim()

      this.log.info(
        `Created remote host script file${
          this.debug ? " - " + remoteTempFile : ""
        }`
      )

      const state = await this.compileScriptFile(scriptFile, {
        runningOnOrigin: true,
      })

      const { script, vmContext } = state

      for (const [key, value] of Object.entries(vmContext)) {
        if (typeof value !== "object") {
          script.vars[key] = value
        }
      }

      const newScript = JSON.stringify(script, null, "  ")
      let readStream = new Readable({
        read(size) {
          this.push(newScript)
          this.push(null)
        },
      })
      const sftp = ssh.sftp()
      let writeStream = await sftp.createWriteStream(remoteTempFile)

      await util.pipeToPromise(readStream, writeStream)

      const sudo =
        script.assertions &&
        script.assertions.find((assertion) => assertion.hasOwnProperty("runAs"))

      this.log.info(`Running script on remote host`)
      await util.runRemoteCommand(ssh, `octopus ${remoteTempFile}`, {
        sudo,
        password: sshConfig.password,
        log: this.log.output,
        logError: this.log.outputError,
        noThrow: true,
      })
    } finally {
      if (isConnected) {
        if (remoteTempFile && !this.debug) {
          this.log.info("Deleting remote temp file")
          await util.runRemoteCommand(ssh, `rm ${remoteTempFile}`)
        }

        ssh.close()
        this.log.info(
          `Disconnected from ${ssh.config[0].host}:${ssh.config[0].port}`
        )
      }

      process.stdin.unref() // To free the Node event loop
    }
  }

  async run(argv) {
    const options = {
      boolean: ["help", "version", "debug", "verbose"],
      string: ["host", "host-file", "user", "port", "password", "set"],
      alias: {
        h: "host",
        u: "user",
        p: "port",
        f: "host-file",
        P: "password",
        s: "set",
        v: "verbose",
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${version.fullVersion}`)
      return 0
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [options] <script-file>

Description:

Runs an Octopus configuration script. If a host or host-file file is
given then the script will be run on those hosts using SSH. Node.js
and Octopus will be installed on the remote hosts if it is not already
present.  For this to work the given user must have sudo privileges on
the remote host.

Options:
  --help              Shows this help
  --version           Shows the tool version
  --host, -h          Remote host name. Default is to run the script
                      directly, without a remote proxy
  --port, -p          Remote port number. Default is 22
  --user, -u          Remote user name. Defaults to current user.
  --password, -P      Remote user password. Defaults is to just use PPK.
  --host-file, -f     JSON5 file containing multiple host names
  --verbose           Emit verbose output
`)
      return 0
    }

    if (!args._.length !== 1) {
      throw new Error("Please specify just one script file")
    }

    let scriptFiles = args._[0]

    if (!args.host && (args.port || args.user || args.password)) {
      this.log.warning(
        "Port, user and password supplied without host are ignored; script will run locally"
      )
    }

    const parsePort = (s) => {
      const port = parseInt(args.port)

      if (args.port && (port < 0 || port > 65535)) {
        throw new Error("Port must be a number between 0 and 65535")
      }

      return port
    }

    let hosts = null

    if (args.host || args["host-file"]) {
      hosts = []

      if (args["host-file"]) {
        hosts = hosts.concat(JSON5.parse(fs.readFile(args["host-file"])))
      }

      if (args.host) {
        hosts.push({
          host: args.host,
          user: args.user,
          password: args.password,
          port: parsePort(args.port),
        })
      }
    }

    let exitCode = 0

    if (hosts) {
      for (const host of hosts) {
        const hostExitCode = await this.runScriptRemotely(scriptFile, {
          host: host.host,
          user: host.user,
          password: host.password,
          port: parsePort(host.port),
          verbose: args.verbose,
        })

        if (hostExitCode !== 0 && exitCode === 0) {
          exitCode = hostExitCode
        }
      }
    } else {
      exitCode = await this.runScriptLocally(scriptFile, {
        verbose: args.verbose,
      })
    }

    return exitCode
  }
}
