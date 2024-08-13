<template>
  <div>
    <div class="upload-drag" @click="handleClick">
      <input
        type="file"
        ref="fileInput"
        @change="handleUploadFile"
        accept=""
        multiple="false"
        style="display: none"
      />
      <div>
        <i class="el-icon-upload" style="font-size: 50px; color: #c0c4cc"></i>
      </div>
    </div>
    <div
      style="display: flex; margin-top: 10px"
      v-for="item in uploadFileList"
      :key="item.fileHash"
    >
      <div style="width: 300px">
        <el-progress
          type="line"
          :text-inside="true"
          :stroke-width="26"
          :percentage="item.percentage"
        ></el-progress>
        <div>
          <div style="margin-left: 4px">
            <div
              v-if="item.state === 0"
              style="height: 24px; width: 100%"
            ></div>
            <p v-else-if="item.state === 1">正在解析中...</p>
            <p v-else-if="item.state === 2">正在上传中...</p>
            <p v-else-if="item.state === 3">上传完成</p>
            <p v-else-if="item.state === 4">上传失败</p>
          </div>
        </div>
      </div>
      <!-- 在处理文件中时不能取消 -->
      <el-button
        v-if="![0, 1].includes(item.state)"
        style="margin-left: 10px; height: 40px"
        type="danger"
        @click="cancelUpload(item)"
        >取消</el-button
      >
    </div>
  </div>
</template>

<script setup>
import { uploadFile, mergeChunk } from "@/api/index.js";
import { reactive, ref, toRefs } from "vue";
// 1kb = 1024b   1kb * 1024 = 1M
// 切片大小 1 * 1024 * 1024 刚好1M
const chunkSize = ref(1 * 1024 * 1024);
// 上传文件列表:
const uploadFileList = ref([]);
// 请求最大并发数
const maxRequest = ref(6);

const fileInput = ref();

const handleClick = () => {
  fileInput.value.dispatchEvent(new MouseEvent("click"));
};

const handleUploadFile = () => {
  // 没有文件内容
  if (
    !fileInput.value ||
    !fileInput.value.files ||
    fileInput.value.files.length === 0
  )
    return false;
  const files = fileInput.value.files;
  console.log(files);
  // 多文件
  Array.from(files).forEach(async (file, index) => {
    let inTaskArrItem = reactive({
      id: new Date() + index,
      // 0是什么都不做,1文件处理中,2是上传中,3是暂停,4是上传完成,5上传中断，6是上传失败
      state: 0,
      fileHash: "",
      fileName: file.name,
      fileSize: file.size,
      allChunkList: [], // 所有请求的数据
      whileRequests: [], // 正在请求中的请求个数，一直保存请求个数为6
      finishNumber: 0,
      errNumber: 0, // 超过3个直接上传中断
      percentage: 0, // 单文件上传进度条
    });
    uploadFileList.value.push(inTaskArrItem);

    inTaskArrItem.state = 1;
    if (file.size === 0) {
      // 直接取消该文件的上传
      uploadFileList.value.splice(index, 1);
    }

    const { fileHash, fileChunkList } = await useWorker(file);
    console.log(fileHash, "文件hash计算完成");

    // 解析完成开始上传文件
    let baseName = "";
    // 查找'.'在fileName中最后出现的位置
    const lastIndex = file.name.lastIndexOf(".");
    // 如果'.'不存在，则返回整个文件名
    if (lastIndex === -1) {
      baseName = file.name;
    }
    // 否则，返回从fileName开始到'.'前一个字符的子串作为文件名（不包含'.'）
    baseName = file.name.slice(0, lastIndex);

    // 这里要注意！可能同一个文件，是复制出来的，出现文件名不同但是内容相同，导致获取到的hash值也是相同的
    // 所以文件hash要特殊处理
    inTaskArrItem.fileHash = `${fileHash}${baseName}`;
    inTaskArrItem.state = 2;
    // 初始化需要上传所有切片列表
    // const { allChunkList } = toRefs(inTaskArrItem);
    inTaskArrItem.allChunkList = fileChunkList.map((item, index) => {
      return {
        // 总文件hash
        fileHash: `${fileHash}${baseName}`,
        // 总文件size
        fileSize: file.size,
        // 总文件name
        fileName: file.name,
        index: index,
        // 切片文件本身
        chunkFile: item.chunkFile,
        // 单个切片hash,以 - 连接
        chunkHash: `${fileHash}-${index}`,
        // 切片文件大小
        chunkSize: chunkSize.value,
        // 切片个数
        chunkNumber: fileChunkList.length,
        // 切片是否已经完成
        finish: false,
      };
    });
    // console.log(inTaskArrItem);
    //  逐步对单个文件进行切片上传
    uploadSingleFile(inTaskArrItem);
  });
  console.log(uploadFileList.value, "uploadFileList");
};

function useWorker(file) {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("@/worker/hash-worker.js", import.meta.url)
      // {
      //   type: "module",
      // }
    );
    worker.postMessage({ file: file, chunkSize: chunkSize.value });
    worker.onmessage = (e) => {
      const { fileHash, fileChunkList } = e.data;
      if (fileHash) {
        resolve({
          fileHash,
          fileChunkList,
        });
      }
    };
  });
}

// 单个文件上传
function uploadSingleFile(taskArrItem) {
  // 如果没有需要上传的切片 / 正在上传的切片还没传完，就不做处理
  if (
    taskArrItem.allChunkList.length === 0 ||
    taskArrItem.whileRequests.length > 0
  ) {
    return false;
  }
  // 找到文件处于处理中/上传中的 文件列表（是文件而不是切片）
  const isTaskArrIng = uploadFileList.value.filter(
    (itemB) => itemB.state === 1 || itemB.state === 2
  );

  // 实时动态获取并发请求数,每次调请求前都获取一次最大并发数
  // 浏览器同域名同一时间请求的最大并发数限制为6
  // 例如如果有3个文件同时上传/处理中，则每个文件切片接口最多调 6 / 3 == 2个相同的接口
  maxRequest.value = Math.ceil(6 / isTaskArrIng.length);

  // 从数组的末尾开始提取 maxRequest 个元素。
  let whileRequest = taskArrItem.allChunkList.slice(-maxRequest.value);

  // 设置正在请求中的个数
  taskArrItem.whileRequests.push(...whileRequest);
  //  如果总请求数大于并发数
  if (taskArrItem.allChunkList.length > maxRequest.value) {
    // 则去掉即将要请求的列表
    taskArrItem.allChunkList.splice(-maxRequest.value);
  } else {
    // 否则总请求数置空,说明已经把没请求的全部放进请求列表了，不需要做过多请求
    taskArrItem.allChunkList = [];
  }

  // 单个分片请求
  const uploadChunk = async (needObj) => {
    const fd = new FormData();
    const {
      fileHash,
      fileSize,
      fileName,
      index,
      chunkFile,
      chunkHash,
      chunkSize,
      chunkNumber,
    } = needObj;
    fd.append("fileHash", fileHash);
    fd.append("fileSize", String(fileSize));
    fd.append("fileName", fileName);
    fd.append("index", String(index));
    fd.append("chunkFile", chunkFile);
    fd.append("chunkHash", chunkHash);
    fd.append("chunkSize", String(chunkSize));
    fd.append("chunkNumber", String(chunkNumber));
    const res = await uploadFile(fd).catch(() => {});
    // 先判断是不是取消状态，就什么都不要再做了,及时停止
    if (taskArrItem.state === 5) {
      return false;
    }

    // 请求异常,或者请求成功服务端返回报错都按单片上传失败逻辑处理,.then.catch的.catch是只能捕捉请求异常的
    if (!res || res.code === -1) {
      // 切片上传失败+1
      taskArrItem.errNumber++;
      // 超过3次之后直接上传中断
      if (taskArrItem.errNumber > 3) {
        console.log("切片上传失败超过三次了");
        // 标识文件上传失败
        taskArrItem.state = 4;
      } else {
        console.log("切片上传失败还没超过3次");
        uploadChunk(needObj); // 失败了一片,继续当前分片请求
      }
    } else if (res.code === 0) {
      // 单个文件上传失败次数大于0则要减少一个
      taskArrItem.errNumber > 0 ? taskArrItem.errNumber-- : 0;
      // 单个文件切片上传成功数+1
      taskArrItem.finishNumber++;
      // 单个切片上传完成
      needObj.finish = true;
      // 单个文件上传成功后就要更新文件进度条
      singleFileProgress(needObj, taskArrItem); // 更新进度条
      // 上传成功了就删掉请求中数组中的那一片请求
      taskArrItem.whileRequests = taskArrItem.whileRequests.filter(
        (item) => item.chunkFile !== needObj.chunkFile
      );

      // 如果单个文件最终成功数等于切片个数
      if (taskArrItem.finishNumber === chunkNumber) {
        // 全部上传完切片后就开始合并切片
        handleMerge(taskArrItem);
      } else {
        // 如果还没完全上传完，则继续上传
        uploadSingleFile(taskArrItem);
      }
    }
  };
  // 开始上传单个切片
  for (const item of whileRequest) {
    uploadChunk(item);
  }
}

// 调取合并接口处理所有切片
async function handleMerge(taskArrItem) {
  const { fileName, fileHash } = taskArrItem;
  const res = await mergeChunk({
    chunkSize: chunkSize.value,
    fileName,
    fileHash,
  }).catch(() => {});
  //  如果合并成功则标识该文件已经上传完成
  if (res && res.code === 0) {
    // 设置文件上传状态
    finishTask(taskArrItem);
    console.log("文件合并成功！");
  } else {
    // 否则上传文件失败
    taskArrItem.state = 4;
    console.log("文件合并失败！");
  }
  //  最后赋值文件切片上传完成个数为0
  taskArrItem.finishNumber = 0;
}

// 更新单个文件进度条
function singleFileProgress(needObj, taskArrItem) {
  taskArrItem.percentage = Number(
    ((taskArrItem.finishNumber / needObj.chunkNumber) * 100).toFixed(2)
  );
}

// 设置单个文件上传已完成
function finishTask(item) {
  item.state = 3;
  item.percentage = 100;
}

function cancelUpload(item) {
  item.state = 5;
  // 取消上传后删除该文件
  uploadFileList.value = uploadFileList.value.filter(
    (itemB) => itemB.fileHash !== item.fileHash
  );
}

// 这个二分返回的一定是数组中第一个关于target的元素，如果没有这个元素则返回他插入的位置
// const midNum = (nums, target) => {
//   let left = 0,
//     right = nums.length - 1;
//   while (left <= right) {
//     const mid = Math.floor((left + right) / 2);
//     if (nums[mid] < target) {
//       left = mid + 1;
//     } else {
//       right = mid - 1;
//     }
//   }
//   return left;
// };
</script>

<style>
.upload-drag {
  width: 150px;
  height: 80px;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #fff;
  border: 1px dashed #d8d8d8;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.2s ease;
}
.upload-drag:hover {
  border: 1px dashed #4595eb;
}
</style>
