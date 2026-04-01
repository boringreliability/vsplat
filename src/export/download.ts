/**
 * Browser download trigger via hidden anchor tag.
 *
 * Creates a Blob from the export data, generates an object URL,
 * programmatically clicks a hidden <a> element, and cleans up.
 */

/**
 * Trigger a browser file download.
 *
 * @param data The file content as an ArrayBuffer
 * @param filename Suggested filename for the download
 */
export function triggerDownload(data: ArrayBuffer, filename: string): void {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}
