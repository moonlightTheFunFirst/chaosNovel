import GraphemerModule from "graphemer";
const Graphemer = GraphemerModule.default ?? GraphemerModule;
const splitter = new Graphemer();
export const normalize = (text) => text.replace(/\r\n?/g, "\n");
export const split = (text) => splitter.splitGraphemes(normalize(text));
export const count = (text) => split(text).length;
