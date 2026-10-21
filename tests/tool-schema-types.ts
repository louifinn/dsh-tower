// Compile-time contracts for the TypeBox-driven tool define path (#45).
import { Type } from '@sinclair/typebox'
import type { DefineTool } from '../types/index.js'

declare const define: DefineTool
declare const ctx: any
const Input = Type.Object({
  repoRoot: Type.String(),
  mode: Type.Unsafe<'a' | 'b'>({ type: 'string', enum: ['a', 'b'] }),
  limit: Type.Optional(Type.Integer()),
})

define(ctx, {
  name: 'fixture',
  description: 'fixture',
  parameters: Input,
  async execute(args) {
    const repoRoot: string = args.repoRoot
    const mode: 'a' | 'b' = args.mode
    // @ts-expect-error required key omitted from the TypeBox schema
    void args.missing
    // @ts-expect-error value outside the schema enum
    const bad: 'a' | 'b' = 'c'
    return { repoRoot, mode, bad }
  },
})
