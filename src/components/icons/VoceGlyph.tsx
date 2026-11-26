// Voce hand mark: four voice bars fanned into a waving hand.
const VoceGlyph = ({
  width,
  height,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) => (
  <svg
    width={width || 24}
    height={height || 24}
    viewBox="0 0 24 24"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path fill="currentColor" d="M11.85 18.04L4.65 14.05A1.31 1.31 0 0 0 3.39 16.34L10.58 20.33A1.31 1.31 0 0 0 11.85 18.04ZM7.84 12.96L6.01 7.65A1.31 1.31 0 0 0 3.54 8.50L5.37 13.81A1.31 1.31 0 0 0 7.84 12.96ZM12.11 12.62L10.30 3.31A1.31 1.31 0 0 0 7.74 3.81L9.55 13.12A1.31 1.31 0 0 0 12.11 12.62ZM16.36 12.28L15.96 4.50A1.31 1.31 0 0 0 13.35 4.64L13.75 12.42A1.31 1.31 0 0 0 16.36 12.28ZM20.59 11.94L20.97 7.56A1.31 1.31 0 0 0 18.37 7.33L17.98 11.72A1.31 1.31 0 0 0 20.59 11.94ZM9.36 21.73L18.63 20.59A3.02 3.02 0 0 0 17.89 14.58L8.62 15.72A3.02 3.02 0 0 0 9.36 21.73Z" />
  </svg>
);

export default VoceGlyph;
