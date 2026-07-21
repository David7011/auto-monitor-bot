import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import type React from "react"
import "./globals.css"
import { AppShell } from "@/components/app-shell"
import { LiveBackground } from "@/components/fx/live-background"
import { ToastProvider } from "@/components/ui/toast"

const geist = Geist({ subsets: ["latin", "cyrillic"], variable: "--font-geist" })
const geistMono = Geist_Mono({ subsets: ["latin", "cyrillic"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: "Auto Monitor — Центр мониторинга",
  description: "Высокотехнологичный центр мониторинга автомобильного рынка с быстрыми уведомлениями",
}

export const viewport: Viewport = {
  themeColor: "#090A0D",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">
        <LiveBackground />
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  )
}
