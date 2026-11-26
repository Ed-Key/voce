import React from "react";
import { InfoButton } from "./InfoButton";

interface PageHeaderProps {
  title: string;
  /** A muted number after the title, such as the call count. */
  count?: number;
  /** Explanation behind an (i) beside the title. */
  info?: React.ReactNode;
  /** At most one quiet and one filled action. */
  actions?: React.ReactNode;
}

/** The one page header: 22 px title on the left, actions on the right. */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  count,
  info,
  actions,
}) => (
  <header className="v-ph">
    <h1>
      {title}
      {count !== undefined && <span className="v-count">{count}</span>}
      {info && (
        <InfoButton size={15} strong position="bottom">
          {info}
        </InfoButton>
      )}
    </h1>
    {actions && <div className="v-pa">{actions}</div>}
  </header>
);
