export const CONTROLLER_ABI = [
  {
    inputs: [
      {
        internalType: 'enum IController.Action[]',
        name: 'actionList',
        type: 'uint8[]',
      },
      {
        internalType: 'bytes[]',
        name: 'paramsDataList',
        type: 'bytes[]',
      },
      {
        internalType: 'address[]',
        name: 'tokensToSettle',
        type: 'address[]',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'token',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'permitAmount',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'deadline',
                type: 'uint256',
              },
              {
                internalType: 'uint8',
                name: 'v',
                type: 'uint8',
              },
              {
                internalType: 'bytes32',
                name: 'r',
                type: 'bytes32',
              },
              {
                internalType: 'bytes32',
                name: 's',
                type: 'bytes32',
              },
            ],
            internalType: 'struct IController.PermitSignature',
            name: 'signature',
            type: 'tuple',
          },
        ],
        internalType: 'struct IController.ERC20PermitParams[]',
        name: 'erc20PermitParamsList',
        type: 'tuple[]',
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'deadline',
                type: 'uint256',
              },
              {
                internalType: 'uint8',
                name: 'v',
                type: 'uint8',
              },
              {
                internalType: 'bytes32',
                name: 'r',
                type: 'bytes32',
              },
              {
                internalType: 'bytes32',
                name: 's',
                type: 'bytes32',
              },
            ],
            internalType: 'struct IController.PermitSignature',
            name: 'signature',
            type: 'tuple',
          },
        ],
        internalType: 'struct IController.ERC721PermitParams[]',
        name: 'erc721PermitParamsList',
        type: 'tuple[]',
      },
      {
        internalType: 'uint64',
        name: 'deadline',
        type: 'uint64',
      },
    ],
    name: 'execute',
    outputs: [
      {
        internalType: 'OrderId[]',
        name: 'ids',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const
