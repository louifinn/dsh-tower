// The only lib/ module that imports node:fs (#50).
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const { createWriteStream } = fs
export { fs, fsp, createWriteStream }
