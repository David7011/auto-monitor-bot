import type React from "react"
import { cn } from "@/lib/utils"

export type Column<T> = {
  key: string
  header: string
  align?: "left" | "right" | "center"
  className?: string
  render: (row: T) => React.ReactNode
}

type DataTableProps<T> = {
  columns: Column<T>[]
  rows: T[]
  getKey: (row: T) => string
  empty?: React.ReactNode
  minWidth?: number
  className?: string
}

/**
 * Modern data grid: glass surface, sticky header, per-row hover highlight and a
 * self-contained horizontal scroll. Replaces raw HTML tables across pages.
 */
export function DataTable<T>({ columns, rows, getKey, empty, minWidth = 720, className }: DataTableProps<T>) {
  const alignCls = (a?: "left" | "right" | "center") => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left")

  return (
    <div className={cn("overflow-x-auto overscroll-x-contain rounded-xl border border-line", className)}>
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line bg-surface-2/70 backdrop-blur">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn("px-3.5 py-2.5 text-[10px] font-semibold tracking-widest text-muted uppercase", alignCls(col.align), col.className)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getKey(row)} className="border-b border-line/60 transition-colors last:border-0 hover:bg-accent/[0.05]">
              {columns.map((col) => (
                <td key={col.key} className={cn("px-3.5 py-2.5 align-middle", alignCls(col.align), col.className)}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-muted">
                {empty ?? "Нет данных"}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
