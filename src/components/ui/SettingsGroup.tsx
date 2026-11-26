import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
}

/** A sentence-case label over one card of hairline-separated rows. */
export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
}) => {
  return (
    <section>
      {title && <h2 className="v-gl">{title}</h2>}
      {description && <p className="v-meta -mt-1 mb-2 ms-3.5">{description}</p>}
      <div className="v-group">{children}</div>
    </section>
  );
};
