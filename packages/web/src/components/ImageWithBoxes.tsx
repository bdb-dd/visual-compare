import type { JSX } from 'react';
import type { BoundingBoxPercent } from '@visual-compare/api/types';

export function ImageWithBoxes({
  src,
  alt,
  boxes,
}: {
  src: string;
  alt: string;
  boxes: BoundingBoxPercent[];
}): JSX.Element {
  return (
    <div className="image-with-boxes">
      <img src={src} alt={alt} />
      {boxes.map((b, i) => (
        <div
          key={i}
          className="bbox"
          style={{
            left: `${b.x}%`,
            top: `${b.y}%`,
            width: `${b.width}%`,
            height: `${b.height}%`,
          }}
        />
      ))}
    </div>
  );
}
