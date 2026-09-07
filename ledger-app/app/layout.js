import './globals.css';

export const metadata = {
  title: 'Ledger — Supplier Link Tracker',
  description: 'Track activation links by supplier and batch.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
