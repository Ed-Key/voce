import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  className?: string;
  menuClassName?: string;
  selectedValue: string | null;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onRefresh?: () => void;
  /** Width in px; every select is 208 unless a row needs another width. */
  width?: number;
}

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  selectedValue,
  onSelect,
  className = "",
  menuClassName,
  placeholder = "Select an option...",
  disabled = false,
  onRefresh,
  width,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );

  const handleSelect = (value: string) => {
    onSelect(value);
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onRefresh) onRefresh();
    setIsOpen(!isOpen);
  };

  return (
    <div
      className={`relative ${className}`}
      ref={dropdownRef}
      style={width ? { width } : undefined}
    >
      <button
        type="button"
        className="v-sel"
        style={width || className ? { width: "100%" } : undefined}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={selectedOption ? "" : "text-text-3"}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          width={14}
          height={14}
          className={`v-chev transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      {isOpen && !disabled && (
        <div
          role="listbox"
          className={`v-menu ${menuClassName ?? "left-0 right-0"}`}
        >
          {options.length === 0 ? (
            <div className="px-2 py-1 v-meta">{t("common.noOptionsFound")}</div>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selectedValue === option.value}
                className={selectedValue === option.value ? "v-on" : ""}
                onClick={() => handleSelect(option.value)}
                disabled={option.disabled}
              >
                <span className="block whitespace-normal break-words">
                  {option.label}
                </span>
                {option.description && <small>{option.description}</small>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
