import "./globals.css";
export const metadata = { title: "Gomon workspace", description: "Governed design memory for engineering calls. Synthetic demo data." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
