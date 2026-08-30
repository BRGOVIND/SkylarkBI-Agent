import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Two faces, chosen for the subject rather than convention: Instrument Sans
 * carries the interface with a slightly technical, condensed voice, and Plex
 * Mono — an instrument/telemetry face — carries every number, timing and tool
 * name, so data always reads visibly as data.
 *
 * Self-hosted by next/font: no third-party request, no layout shift.
 */
const display = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Skylark Intelligence',
  description:
    'Ask across your deals and work orders. Every figure is computed from live monday.com data.',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
