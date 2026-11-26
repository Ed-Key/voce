import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: "default" | "compact";
}

/** A text field in the shared control style (30 px high, 208 px unless sized). */
export const Input: React.FC<InputProps> = ({
  className = "",
  variant: _variant,
  ...props
}) => <input className={`v-field ${className}`} {...props} />;
