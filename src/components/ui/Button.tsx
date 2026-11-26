import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "primary-soft"
    | "secondary"
    | "warning"
    | "danger"
    | "danger-ghost"
    | "ghost";
  size?: "sm" | "md" | "lg";
}

// Filled iris is kept for the one main action on a page and for on states.
const variantClasses = {
  primary: "v-primary",
  "primary-soft": "v-secondary",
  secondary: "v-secondary",
  warning: "v-secondary",
  danger: "v-primary !bg-danger",
  "danger-ghost": "v-ghost v-danger",
  ghost: "v-ghost",
};

const sizeClasses = {
  sm: "!h-[26px] !px-2.5 !text-xs",
  md: "",
  lg: "!h-9 !px-4",
};

export const Button: React.FC<ButtonProps> = ({
  children,
  className = "",
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}) => (
  <button
    type={type}
    className={`v-btn ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    {...props}
  >
    {children}
  </button>
);
