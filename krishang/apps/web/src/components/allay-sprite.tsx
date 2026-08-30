import Image from "next/image";

type AllaySpriteProps = {
  busy: boolean;
};

export function AllaySprite({ busy }: AllaySpriteProps) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={busy ? "allay-sprite is-busy" : "allay-sprite"}
      draggable={false}
      height={545}
      priority
      src="/assets/allay/allay-je2.png"
      width={577}
    />
  );
}
