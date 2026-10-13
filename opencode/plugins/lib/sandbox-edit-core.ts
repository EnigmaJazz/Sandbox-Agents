/** Pure targeted-edit implementation shared by the plugin and contract tests. */
export function applyTargetedEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString.length === 0) {
    throw new Error("sandbox_edit: oldString must not be empty");
  }
  const firstIndex = content.indexOf(oldString);
  if (firstIndex === -1) {
    throw new Error("sandbox_edit: oldString was not found");
  }
  const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
  if (secondIndex !== -1 && !replaceAll) {
    throw new Error(
      "sandbox_edit: oldString matched multiple times; set replaceAll to true to replace all",
    );
  }
  const result = replaceAll
    ? content.split(oldString).join(newString)
    : `${content.slice(0, firstIndex)}${newString}${content.slice(firstIndex + oldString.length)}`;
  if (result.length === 0) {
    throw new Error("sandbox_edit: edit would leave the file empty");
  }
  return result;
}
