/**
 * Why no face template was made from a photo, in words an operator can act on.
 * Shared by the stranger panel (toast) and the server (notification, log).
 * An unknown code is still shown, never swallowed.
 */
export function templateRejectReason(reason?: string | null): string {
  switch (reason) {
    case null:
    case undefined:
    case "":
      return "";
    case "multiple-faces":
      return "Ảnh có nhiều người nên không biết chọn khuôn mặt nào - hãy chọn ảnh chỉ có người này.";
    case "face-mismatch":
      return "Không tìm thấy đúng khuôn mặt của cụm trong ảnh - hãy chọn ảnh khác của người này.";
    case "not-frontal":
      return "Khuôn mặt không nhìn thẳng - hãy chọn ảnh nhìn thẳng.";
    case "low-quality":
      return "Khuôn mặt quá nhỏ hoặc mờ - hãy chọn ảnh rõ hơn.";
    case "template-cap":
      return "Người này đã đủ số mẫu tối đa và mẫu nào cũng rõ hơn ảnh này - không cần thêm.";
    case "duplicate":
      return "Ảnh này trùng với một mẫu đã có.";
    case "no-face":
      return "Không thấy khuôn mặt trong ảnh - hãy chọn ảnh khác.";
    case "unsupported-image":
      return "Không đọc được ảnh đã chọn - hãy chọn ảnh khác.";
    case "engine-unavailable":
    case "engine-disabled":
    case "engine-error":
      return "Bộ nhận diện khuôn mặt chưa sẵn sàng - thử lại sau.";
    default:
      return `Mã lỗi: ${reason}.`;
  }
}
