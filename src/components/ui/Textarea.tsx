import React from "react";

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: "default" | "compact";
}

/** Multi-line field: monospace, because prompts are instructions, not prose. */
export const Textarea: React.FC<TextareaProps> = ({
  className = "",
  variant = "default",
  ...props
}) => (
  <textarea
    className={`v-field w-full h-auto whitespace-pre-wrap py-2 resize-y font-mono text-[12.5px] leading-[19px] font-normal ${
      variant === "compact" ? "min-h-[80px]" : "min-h-[92px]"
    } ${className}`}
    {...props}
  />
);
