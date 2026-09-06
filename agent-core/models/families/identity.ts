/** Last path segment of a vendor/model id. */
export function modelLeaf(model: string): string {
  const n = model.trim().toLowerCase();
  const slash = n.lastIndexOf("/");
  return slash >= 0 ? n.slice(slash + 1) : n;
}
