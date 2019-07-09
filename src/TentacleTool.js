import parseArgs from "minimist"
import JSON5 from "@johnls/JSON5"
import fs from "fs-extra"
import { fullVersion } from "./version"
import autobind from "autobind-decorator"
import * as asserters from "./asserters"

class ScriptError extends Error {
  constructor(message, fileName, node) {
    const lineNumber = node.line
    const columnNumber = node.column

    super(message, fileName, lineNumber, columnNumber)
    this.message = `(${fileName}:${lineNumber}:${columnNumber}) ${message}`
  }
}

@autobind
export class TentacleTool {
  constructor(toolName, log, options) {
    options = options || {}
    this.toolName = toolName
    this.log = log
    this.debug = options.debug
  }

  async run(argv) {
    // TODO: Add a --server flag that starts an HTTP server and waits for requests

    const options = {
      boolean: ["verbose", "help", "version", "debug"],
      string: [],
      alias: {
        v: "verbose",
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${fullVersion}`)
      return 0
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [<options>] [<script-file>]

Description:

Runs an Octopus configuration script on localhost. Can take input from
the command line or through an HTTP service running on localhost.

Options:
  --verbose           Give verbose output
  --help              Shows this help
  --version           Shows the tool version
`)
      return 0
    }

    const scriptFileName = args._[0]

    if (!scriptFileName) {
      throw new Error("Must supply an script file")
    }

    const scriptNodes = JSON5.parse(await fs.readFile(scriptFileName), {
      wantNodes: true,
    })

    this.processScriptFile(scriptFileName, scriptNodes, args.verbose)

    return 0
  }

  async processScriptFile(scriptFileName, scriptNodes, verbose) {
    const newScriptError = (message, node) => {
      return new ScriptError(message, scriptFileName, node)
    }

    if (scriptNodes.type !== "object") {
      throw newScriptError(
        "Script must have an object as the root",
        scriptNodes
      )
    }

    // This is the execution context that holds execution state
    const context = {
      vars: { ...process.env },
    }

    const {
      options: optionsNode,
      variables: varsNode,
      assertions: assertionsNode,
    } = scriptNodes.value

    if (optionsNode) {
      if (optionsNode.type !== "object") {
        throw newScriptError("'options' must be an object", optionsNode)
      }

      const { description: descriptionNode } = optionsNode.value

      if (descriptionNode) {
        if (descriptionNode.type !== "string") {
          throw newScriptError(
            "'options.description' must be a string",
            descriptionNode
          )
        }

        context.description = descriptionNode.value
        this.log.info(`${context.description}`)
      }
    }

    if (varsNode) {
      if (varsNode.type !== "object") {
        throw newScriptError("'variables' must be an object", varsNode)
      }

      for (const [key, value] of Object.entries(varsNode.value)) {
        switch (value.type) {
          case "null":
            delete context.vars[key]
            break
          case "numeric":
          case "boolean":
            context.vars[key] = value.value.toString()
            break
          case "string":
            context.vars[key] = value.value
            break
          default:
            throw newScriptError(
              `Variable of type ${value.type} is invalid`,
              value
            )
        }
      }
    }

    if (verbose) {
      this.log.info(JSON5.stringify(context.vars, null, "  "))
    }

    if (!assertionsNode) {
      this.log.warn("No 'assertions' found")
      return
    }

    if (assertionsNode.type !== "array") {
      throw newScriptError("'assertions' must be an array", assertionsNode)
    }

    context.assertions = []

    for (const assertionNode of assertionsNode.value) {
      if (assertionNode.type !== "object") {
        throw newScriptError("Assertion must be an object", assertionNode)
      }

      const assertion = {}
      const {
        description: descriptionNode,
        assert: assertNode,
        with: withNode,
      } = assertionNode.value

      if (assertNode) {
        if (assertNode.type !== "string") {
          throw newScriptError(
            "Assertion 'assert' must be a string",
            assertNode
          )
        }
        assertion.name = assertNode.value
      } else {
        throw newScriptError("Assertion has no 'assert' value", assertNode)
      }

      if (descriptionNode) {
        if (descriptionNode.type !== "string") {
          throw newScriptError(
            "Assertion 'description' must be a string",
            descriptionNode
          )
        }
        assertion.description = descriptionNode.value
      }

      if (withNode) {
        if (withNode.type !== "object") {
          throw newScriptError("Assertion 'with' must be an object", withNode)
        }

        assertion.args = withNode.value
      }

      context.assertions.push(assertion)
    }

    for (const assertion of context.assertions) {
      const asserter = new asserters[assertion.name]({
        newScriptError,
      })
      let ok = false

      try {
        ok = await asserter.assert(assertion.args)
      } catch (e) {
        throw e
      }

      if (!ok) {
        try {
          await asserter.actualize()
        } catch (e) {
          throw e
        }
        this.log.info(`Actualized '${assertion.name}'`)
      } else {
        this.log.info(`Asserted '${assertion.name}'`)
      }

      // TODO: Put makeError on the context object
      // TODO: Pass context to the asserters
      // TODO: Add a method to expand a string to context
      //
    }
  }
}