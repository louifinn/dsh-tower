// The only lib/ module that imports node:child_process (#50).
import { execFile, spawn } from 'node:child_process'

export { execFile, spawn }
