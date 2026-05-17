// Small branded ring that follows the mouse — shows C_GUIDE is active on this tab.
(function () {
  if (document.getElementById("cguide-companion")) return;

  const ring = document.createElement("div");
  ring.id = "cguide-companion";
  ring.setAttribute("aria-hidden", "true");
  document.documentElement.appendChild(ring);

  let targetX = -100;
  let targetY = -100;
  let renderX = -100;
  let renderY = -100;
  let visible = false;

  const paint = () => {
    renderX += (targetX - renderX) * 0.42;
    renderY += (targetY - renderY) * 0.42;
    ring.style.transform = `translate(calc(${renderX}px - 50%), calc(${renderY}px - 50%))`;
    requestAnimationFrame(paint);
  };

  requestAnimationFrame(paint);

  document.addEventListener(
    "mousemove",
    (e) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!visible) {
        visible = true;
        ring.classList.add("visible");
      }
    },
    true,
  );

  document.addEventListener(
    "mouseleave",
    () => {
      visible = false;
      ring.classList.remove("visible");
    },
    true,
  );
})();
