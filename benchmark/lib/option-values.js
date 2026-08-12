export function expandEqualsArguments(arguments_) {
  return arguments_.flatMap((argument) => {
    const match = /^(--[^=]+)=(.*)$/.exec(argument)

    return match ? [match[1], match[2]] : [argument]
  })
}

export function requiredOption(name, value) {
  if (value === undefined || value === '') {
    throw new TypeError(`${name} requires a value`)
  }

  return value
}

export function positiveIntegerOption(name, value) {
  const number = Number(requiredOption(name, value))

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }

  return number
}

export function nonNegativeIntegerOption(name, value) {
  const number = Number(requiredOption(name, value))

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }

  return number
}

export function cpuIndexOption(name, value) {
  const number = Number(requiredOption(name, value))

  if (!Number.isSafeInteger(number) || number < -1) {
    throw new TypeError(`${name} must be -1 or a non-negative safe integer`)
  }

  return number
}
