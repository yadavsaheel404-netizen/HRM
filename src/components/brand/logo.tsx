import logoUrl from "@/assets/the-ai-school-logo.png";
import { cn } from "@/lib/utils";

export function Logo({
  className,
  variant = "dark",
}: {
  className?: string;
  variant?: "dark" | "light";
}) {
  return (
    <img
      src={logoUrl}
      alt="The AI School"
      className={cn("h-8 w-auto object-contain", variant === "light" && "invert", className)}
    />
  );
}

export function WordMark({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <Logo />
      <div className="leading-tight">
        <p className="font-display text-sm font-semibold tracking-tight">HRM Portal</p>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
    </div>
  );
}
