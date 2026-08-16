// zlib shim — js-mdict@6 只用了 zlib.inflateSync(键块/记录块解压)。
// 浏览器里用 pako(MIT) 实现等价功能。
import { inflate } from 'pako';

export default {
  inflateSync(buf){
    return inflate(buf);
  },
};
