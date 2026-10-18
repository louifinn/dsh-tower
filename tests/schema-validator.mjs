// Test-side mirror of the enforced subset of DSH's output validator
// (`validateJsonSchemaValue` from @deepseek-ai/dsh-tools). DSH validates every
// successful tool value against `tool.output.schema`, so a schema that rejects
// a value (a `null` where `type: 'string'` was declared, for example) turns a
// successful call into a ToolOutputError in the real runtime. Keep this helper
// in sync with the subset the plugin actually uses.
export function validateJsonSchema(schema, value, path = 'value') {
  const violations = []
  check(schema, value, path, violations)
  return violations
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeMatches(type, value) {
  switch (type) {
    case 'null':
      return value === null
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'json':
      return true
    default:
      return true
  }
}

function check(schema, value, path, violations) {
  if (!schema || typeof schema !== 'object') return
  const keys = Object.keys(schema)
  if (keys.length === 0) return

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      const branchViolations = []
      check(branch, value, path, branchViolations)
      return branchViolations.length === 0
    }).length
    if (matches !== 1) violations.push(`"${path}" must match exactly one oneOf branch (matched ${matches})`)
    return
  }

  const type = schema.type
  if (typeof type === 'string' && !typeMatches(type, value)) {
    violations.push(`"${path}" must be a ${type}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`"${path}" must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    violations.push(`"${path}" must be ${JSON.stringify(schema.const)}`)
  }

  const objectLike = type === 'object' || (type === undefined && isPlainObject(value) && schema.properties)
  if (objectLike && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`"${path}.${key}" is required`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) check(child, value[key], `${path}.${key}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`"${path}.${key}" is not allowed`)
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) check(schema.items, item, `${path}[${index}]`, violations)
  }
}
