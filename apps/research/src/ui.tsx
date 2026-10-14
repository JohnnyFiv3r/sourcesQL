import { useLayoutEffect, useRef, type ComponentProps } from "react";

// Small, owned shadcn-style primitives; native semantics and visible focus are retained.
export function Button({
  className = "",
  variant = "default",
  ...props
}: ComponentProps<"button"> & { variant?: "default" | "primary" | "ghost" }) {
  return <button className={`button ${variant} ${className}`} {...props} />;
}
export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`input ${className}`} {...props} />;
}
export function Textarea({
  className = "",
  ...props
}: ComponentProps<"textarea">) {
  return <textarea className={`input textarea ${className}`} {...props} />;
}
function sizeTextarea(input: HTMLTextAreaElement) {
  const style = getComputedStyle(input);
  const line = parseFloat(style.lineHeight);
  const padding =
    parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border =
    parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const minimum = Math.ceil(line * 2 + padding + border);
  const maximum = Math.ceil(line * 3 + padding + border);
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  const height = Math.max(minimum, input.scrollHeight + border);
  input.style.height = `${Math.min(height, maximum)}px`;
  input.style.overflowY = height > maximum ? "auto" : "hidden";
}
export function GrowingTextarea({
  className = "",
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "ref" | "rows">) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (input.current) sizeTextarea(input.current);
  }, [value]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (width === nextWidth) return;
      width = nextWidth;
      sizeTextarea(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Textarea
      {...props}
      ref={input}
      value={value}
      rows={2}
      className={`growing-textarea ${className}`}
    />
  );
}
export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select className={`input select ${className}`} {...props} />;
}
export function Badge({ className = "", ...props }: ComponentProps<"span">) {
  return <span className={`badge ${className}`} {...props} />;
}
