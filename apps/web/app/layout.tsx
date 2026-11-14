import "./globals.css";
export const metadata = { title: "Gomon workspace", description: "Governed design memory for engineering calls. Synthetic demo data." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500&family=Geist+Mono:wght@400;500&display=swap" />
  </head><body>{children}</body></html>);
}
