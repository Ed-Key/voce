import React from "react";
import SelectComponent, { components } from "react-select";
import { ChevronDown } from "lucide-react";
import CreatableSelect from "react-select/creatable";
import type {
  ActionMeta,
  DropdownIndicatorProps,
  Props as ReactSelectProps,
  SingleValue,
  StylesConfig,
} from "react-select";

export type SelectOption = {
  value: string;
  label: string;
  isDisabled?: boolean;
};

type BaseProps = {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isClearable?: boolean;
  onChange: (value: string | null, action: ActionMeta<SelectOption>) => void;
  onBlur?: () => void;
  className?: string;
  formatCreateLabel?: (input: string) => string;
};

type CreatableProps = {
  isCreatable: true;
  onCreateOption: (value: string) => void;
};

type NonCreatableProps = {
  isCreatable?: false;
  onCreateOption?: never;
};

export type SelectProps = BaseProps & (CreatableProps | NonCreatableProps);

// The same chevron as every other select.
const DropdownIndicator = (
  props: DropdownIndicatorProps<SelectOption, false>,
) => (
  <components.DropdownIndicator {...props}>
    <ChevronDown width={14} height={14} />
  </components.DropdownIndicator>
);

const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base, state) => ({
    ...base,
    minHeight: 30,
    height: 30,
    borderRadius: 8,
    borderColor: state.isFocused ? "var(--accent)" : "var(--line-strong)",
    boxShadow: "none",
    backgroundColor: "var(--control)",
    font: "500 13.5px/18px var(--font)",
    color: "var(--text)",
    ":hover": {
      borderColor: state.isFocused
        ? "var(--accent)"
        : "color-mix(in srgb, var(--accent) 45%, var(--line-strong))",
    },
  }),
  valueContainer: (base) => ({
    ...base,
    padding: "0 0 0 11px",
  }),
  input: (base) => ({
    ...base,
    margin: 0,
    padding: 0,
    color: "var(--text)",
  }),
  singleValue: (base) => ({
    ...base,
    color: "var(--text)",
  }),
  indicatorSeparator: () => ({ display: "none" }),
  indicatorsContainer: (base) => ({ ...base, height: 28 }),
  dropdownIndicator: (base) => ({
    ...base,
    padding: "0 8px 0 4px",
    color: "var(--text-2)",
    ":hover": { color: "var(--text)" },
  }),
  clearIndicator: (base) => ({
    ...base,
    padding: "0 2px",
    color: "var(--text-3)",
    ":hover": { color: "var(--text)" },
  }),
  loadingIndicator: (base) => ({ ...base, color: "var(--text-3)" }),
  menu: (provided) => ({
    ...provided,
    zIndex: 30,
    padding: 4,
    borderRadius: 10,
    backgroundColor: "var(--control)",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    boxShadow: "0 12px 32px var(--shadow)",
  }),
  option: (base, state) => ({
    ...base,
    borderRadius: 6,
    padding: "6px 9px",
    font: "500 13.5px/18px var(--font)",
    backgroundColor: state.isFocused ? "var(--hover)" : "transparent",
    color: state.isSelected ? "var(--accent)" : "var(--text)",
    cursor: state.isDisabled ? "not-allowed" : base.cursor,
    opacity: state.isDisabled ? 0.5 : 1,
  }),
  placeholder: (base) => ({
    ...base,
    color: "var(--text-3)",
    fontWeight: 400,
  }),
};

export const Select: React.FC<SelectProps> = React.memo(
  ({
    value,
    options,
    placeholder,
    disabled,
    isLoading,
    isClearable = true,
    onChange,
    onBlur,
    className = "",
    isCreatable,
    formatCreateLabel,
    onCreateOption,
  }) => {
    const selectValue = React.useMemo(() => {
      if (!value) return null;
      const existing = options.find((option) => option.value === value);
      if (existing) return existing;
      return { value, label: value, isDisabled: false };
    }, [value, options]);

    const handleChange = (
      option: SingleValue<SelectOption>,
      action: ActionMeta<SelectOption>,
    ) => {
      onChange(option?.value ?? null, action);
    };

    const sharedProps: Partial<ReactSelectProps<SelectOption, false>> = {
      className,
      classNamePrefix: "app-select",
      value: selectValue,
      options,
      onChange: handleChange,
      placeholder,
      isDisabled: disabled,
      isLoading,
      onBlur,
      isClearable,
      styles: selectStyles,
      components: { DropdownIndicator },
    };

    if (isCreatable) {
      return (
        <CreatableSelect<SelectOption, false>
          {...sharedProps}
          onCreateOption={onCreateOption}
          formatCreateLabel={formatCreateLabel}
        />
      );
    }

    return <SelectComponent<SelectOption, false> {...sharedProps} />;
  },
);

Select.displayName = "Select";
