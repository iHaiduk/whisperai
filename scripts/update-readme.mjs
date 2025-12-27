import fs from "node:fs"
import path from "node:path"

const version = process.argv[2]
const readmePath = path.join(process.cwd(), "README.md")
const content = fs.readFileSync(readmePath, "utf8")
const updated = content.replace(
  /Current Version:\s*[^\n]*/i,
  `Current Version: ${version}`
)
fs.writeFileSync(readmePath, updated)
