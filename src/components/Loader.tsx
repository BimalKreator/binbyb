"use client";

interface LoaderProps {
  /** Optional label below the spinner */
  label?: string;
  /** Size: small (default), medium, large */
  size?: "small" | "medium" | "large";
  className?: string;
}

const sizeClasses = {
  small: "w-6 h-6 border-2",
  medium: "w-10 h-10 border-2",
  large: "w-12 h-12 border-[3px]",
};

export function Loader({ label, size = "small", className = "" }: LoaderProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className}`}
      role="status"
      aria-label={label || "Loading"}
    >
      <div
        className={`${sizeClasses[size]} rounded-full border-slate-600 border-t-[var(--primary)] animate-spin`}
      />
      {label && (
        <span className="text-sm text-slate-400">{label}</span>
      )}
    </div>
  );
}
