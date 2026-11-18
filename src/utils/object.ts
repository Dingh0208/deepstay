export const hasOwn = (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key)
