-- md2word 离线模式过滤器（§4.3）：
-- 丢弃远程图片（不联网抓取），并把被跳过的图片写到 stderr，
-- 由 core 的 stderr 分类器转成 W_IMAGE_OFFLINE warning（不静默失败）。
local function is_remote(src)
  return src:match('^https?://') ~= nil or src:match('^ftp://') ~= nil
end

function Image(el)
  if is_remote(el.src or '') then
    io.stderr:write('[MD2WORD] OFFLINE-IMAGE-SKIPPED: ' .. (el.src or '') .. '\n')
    return {}
  end
  return nil
end
