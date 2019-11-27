import stream from "stream"
import { createNode } from "./testUtil"
import { ScriptError } from "./ScriptError"
import { Utility } from "./util"
import fs from "fs-extra"

const testString = "the quick brown fox jumps over the lazy dog"

test("generateDigestFromFile", async () => {
  const util = new Utility({
    fs: {
      createReadStream: jest.fn((fileName) => {
        return new stream.Readable({
          read(size) {
            this.push(testString)
            this.push(null)
          },
        })
      }),
    },
  })

  await expect(util.generateDigestFromFile(testString)).resolves.toBe(
    "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec"
  )
})

test("generateDigest", () => {
  const util = new Utility()

  expect(util.generateDigest(testString)).toBe(
    "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec"
  )
})

test("pathInfo", async () => {
  const util = new Utility({
    process: {
      geteuid: () => 1,
      getegid: () => 1,
      getgroups: () => [1, 2],
    },
    fs: {
      lstat: async (pathName) => {
        if (pathName === "/noexist") {
          throw new Error()
        } else if (pathName === "/other") {
          return {
            isFile: () => false,
            isDirectory: () => false,
            uid: 0,
            gid: 0,
            size: 0,
            mode: 0o444,
          }
        } else if (pathName === "/file") {
          return {
            isFile: () => true,
            isDirectory: () => false,
            gid: 1,
            uid: 1,
            size: 100,
            mode: 0o777,
          }
        } else if (pathName === "/") {
          return {
            isFile: () => false,
            isDirectory: () => true,
            uid: 0,
            gid: 2,
            size: 0,
            mode: 0o050,
          }
        }
      },
    },
  })

  // File
  await expect(util.pathInfo("/file")).resolves.toEqual({
    access: "rw",
    uid: 1,
    gid: 1,
    mode: "rwxrwxrwx",
    size: 100,
    type: "f",
  })

  // Directory
  await expect(util.pathInfo("/")).resolves.toEqual({
    access: "r-",
    uid: 0,
    gid: 2,
    mode: "---r-x---",
    size: 0,
    type: "d",
  })

  // Other
  await expect(util.pathInfo("/other")).resolves.toEqual({
    type: "o",
    access: "r-",
    mode: "r--r--r--",
    uid: 0,
    gid: 0,
    size: 0,
  })

  // Bad file
  await expect(util.pathInfo("/noexist")).resolves.toEqual({
    type: "-",
    access: "--",
  })
})

test("fileExists", async () => {
  const util = new Utility({
    fs: {
      lstat: jest.fn((path) => {
        if (path === "there") {
          return {
            isFile: () => true,
          }
        } else {
          throw new Error()
        }
      }),
    },
  })

  await expect(util.fileExists("there")).resolves.toBe(true)
  await expect(util.fileExists("notthere")).resolves.toBe(false)
})

test("dirExists", async () => {
  const util = new Utility({
    fs: {
      lstat: jest.fn((path) => {
        if (path === "there") {
          return {
            isDirectory: () => true,
          }
        } else {
          throw new Error()
        }
      }),
    },
  })

  await expect(util.dirExists("there")).resolves.toBe(true)
  await expect(util.dirExists("notthere")).resolves.toBe(false)
})

test("canAccess", async () => {
  const util = new Utility({
    fs: {
      access: jest.fn(async (path) => {
        if (path === "badfile") {
          throw new Error()
        }
      }),
    },
  })

  await expect(util.canAccess("goodfile")).resolves.toBe(true)
  await expect(util.canAccess("badfile")).resolves.toBe(false)
})

test("pipeToPromise", async () => {
  const util = new Utility()
  let readable = new stream.Readable({
    read(size) {
      this.push(testString)
      this.push(null)
    },
  })
  let writeable = new stream.Writable({
    write(chunk, encoding, callback) {
      callback()
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).resolves.toBeUndefined()

  readable = new stream.Readable({
    read(size) {
      process.nextTick(() => this.emit("error", new Error()))
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).rejects.toThrow(Error)

  // Readable is only useful once
  readable = new stream.Readable({
    read(size) {
      this.push(testString)
      this.push(null)
    },
  })
  writeable = new stream.Writable({
    write(chunk, encoding, callback) {
      callback(new Error())
    },
  })

  await expect(util.pipeToPromise(readable, writeable)).rejects.toThrow(Error)
})

test("runningAsRoot", async () => {
  const util = new Utility({
    os: {
      userInfo: jest.fn(() => ({
        uid: 0,
      })),
    },
  })

  expect(util.runningAsRoot()).toBe(true)
})

test("getUsers", async () => {
  const util = new Utility({
    fs: {
      readFile: jest.fn((path, options) => {
        return `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
games:x:5:60:games:/usr/games:/usr/sbin/nologin
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin
mail:x:8:8:mail:/var/mail:/usr/sbin/nologin
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin
proxy:x:13:13:proxy:/bin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
someuser:x:1000:1000:Some User:/home/someuser:/bin/bash
sshd:x:110:65534::/run/sshd:/usr/sbin/nologin
ntp:x:111:113::/nonexistent:/usr/sbin/nologin`
      }),
    },
  })

  await expect(util.getUsers()).resolves.toContainEqual({
    name: "mail",
    password: "x",
    uid: 8,
    gid: 8,
    name: "mail",
    homeDir: "/var/mail",
    shell: "/usr/sbin/nologin",
    comment: "mail",
  })
})

test("getGroups", async () => {
  const util = new Utility({
    fs: {
      readFile: jest.fn((path, options) => {
        return `root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:syslog,someuser
tty:x:5:
disk:x:6:
lp:x:7:
mail:x:8:
news:x:9:
uucp:x:10:
man:x:12:
cdrom:x:24:someuser
floppy:x:25:
tape:x:26:
sudo:x:27:someuser`
      }),
    },
  })

  await expect(util.getGroups()).resolves.toContainEqual({
    name: "adm",
    password: "x",
    gid: 4,
    users: ["syslog", "someuser"],
  })
})

test("parseOwnerNode", async () => {
  const util = new Utility()

  expect(util.parseOwnerNode([], [], null)).toEqual({})

  expect(util.parseOwnerNode([], [], createNode("test.json5", {}))).toEqual({})

  expect(
    util.parseOwnerNode(
      [{ name: "root", uid: 0 }],
      [{ name: "wheel", gid: 0 }],
      createNode("test.json5", {
        user: "root",
        group: "wheel",
      })
    )
  ).toEqual({ uid: 0, gid: 0 })

  expect(
    util.parseOwnerNode(
      [{ name: "root", uid: 0 }],
      [{ name: "wheel", gid: 0 }],
      createNode("test.json5", {
        user: 0,
        group: 0,
      })
    )
  ).toEqual({ uid: 0, gid: 0 })

  expect(() => util.parseOwnerNode([], [], createNode("test.json5"))).toThrow(
    ScriptError
  )

  expect(() =>
    util.parseOwnerNode([], [], createNode("test.json5", { user: true }))
  ).toThrow(ScriptError)

  expect(() =>
    util.parseOwnerNode(
      [],
      [],
      createNode("test.json5", {
        user: 0,
      })
    )
  ).toThrow(Error)

  expect(() =>
    util.parseOwnerNode([], [], createNode("test.json5", { group: true }))
  ).toThrow(ScriptError)

  expect(() =>
    util.parseOwnerNode(
      [],
      [],
      createNode("test.json5", {
        group: 0,
      })
    )
  ).toThrow(Error)
})

test("parseModeNode", async () => {
  const util = new Utility()

  expect(util.parseModeNode(null)).toBe(0o644)

  expect(() => util.parseModeNode(1)).toThrow(ScriptError)

  expect(
    util.parseModeNode(
      createNode("test.json5", {
        user: "-wx",
        group: "r-x",
        other: "r--",
      })
    )
  ).toBe(0o354)

  expect(() =>
    util.parseModeNode(
      createNode("test.json5", {
        user: "abc",
      })
    )
  ).toThrow(ScriptError)

  expect(util.parseModeNode(createNode("test.json5", {}))).toBe(0o000)
})

test("osInfo", async () => {
  const util = new Utility({
    osInfo: async () => ({ id: "", platform: "", version_id: "" }),
  })

  await expect(util.osInfo()).resolves.toEqual({
    id: "",
    platform: "",
    versionId: "",
  })
})

test("parsePort", () => {
  const util = new Utility()

  expect(util.parsePort("123")).toBe(123)
  expect(util.parsePort(123)).toBe(123)
  expect(util.parsePort(true)).toBeUndefined()
  expect(() => util.parsePort("70000")).toThrow(Error)
})

test("expandTilde", async () => {
  const util = new Utility({ process: { env: { HOME: "/x/y" } } })

  expect(util.expandTilde("~/a.txt")).toBe("/x/y/a.txt")
  expect(util.expandTilde("a.txt")).toBe("a.txt")
})

test("userInfo", () => {
  const util = new Utility({
    os: {
      userInfo: () => ({
        username: "",
        uid: 0,
        gid: 0,
        shell: "",
        homedir: "",
      }),
    },
  })

  expect(util.userInfo()).toEqual({
    name: "",
    uid: 0,
    gid: 0,
    shell: "",
    homeDir: "",
  })
})
