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

const TITLE = 'Skylark Intelligence — business intelligence agent';
const DESCRIPTION =
  'Ask questions across your deals and work orders and get answers grounded in live monday.com data, with the coverage behind every number.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'Skylark BI Agent',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Skylark BI Agent',
    type: 'website',
    images: [{ url: '/agent-mark.svg', width: 100, height: 100, alt: 'Skylark BI Agent' }],
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  // A private evaluation deployment reading live business data — keep it out
  // of search indexes.
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
