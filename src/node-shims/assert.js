// assert shim — js-mdict@6 把 node:assert 当断言函数用(格式校验)。
export default function assert(cond, msg){
  if (!cond) throw new Error(msg || 'assertion failed');
}
