export function formatModelLabel(name: string): string {
  const parts = name.split(":");
  return parts[0] + (parts[1] ? ":" + parts[1] : "");
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.getDate().toString().padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}