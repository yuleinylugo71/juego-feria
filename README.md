# Escape the Server Room

Juego tipo Pac-Man para la feria: estás atrapado en una sala de servidores, un virus te persigue y tienes que hackear 4 terminales resolviendo preguntas de lógica (15 segundos cada una) para conseguir las llaves y escapar por la puerta. Tiene 3 niveles.

## Cómo jugar

- **Computadora:** flechas o WASD (toque = 1 cuadro, mantener = avanza seguido). Responde con clic o con las teclas 1 2 3 4. La tecla M quita o pone el sonido.
- **Celular o tablet:** botones de flecha en pantalla o deslizar el dedo sobre el laberinto. Toca la respuesta para contestar.

Todo el juego está en un solo archivo, `index.html`. Funciona sin internet (solo las fuentes se descargan de Google Fonts).

## Cambiar cosas

En `index.html`:

- `QUESTIONS`: las preguntas (`a: 0` indica que la primera opción es la correcta; las opciones se mezclan solas).
- `TIME_LIMIT`: segundos para responder.
- `LEVELS`: los laberintos y la velocidad del virus en cada nivel.
