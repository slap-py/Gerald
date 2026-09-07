import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Gerald Console',
  description: 'Private assistant operations console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
